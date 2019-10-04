import ffi from "ffi";
import Struct from "ref-struct";
import { Stores } from "../schema/stores";
import { KotsApp } from "./";
import { Params } from "../server/params";
import { putObject } from "../util/s3";
import path from "path";
import tmp from "tmp";
import fs from "fs";
import {
  extractDownstreamNamesFromTarball,
  extractCursorAndVersionFromTarball,
  extractPreflightSpecFromTarball,
  extractSupportBundleSpecFromTarball,
  extractAppSpecFromTarball,
  extractKotsAppSpecFromTarball,
  extractAppTitleFromTarball,
  extractAppIconFromTarball
} from "../util/tar";
import { Cluster } from "../cluster";
import * as _ from "lodash";
import yaml from "js-yaml";
import { StatusServer } from "../airgap/status";

const GoString = Struct({
  p: "string",
  n: "longlong"
});

function kots() {
  return ffi.Library("/lib/kots.so", {
    PullFromLicense: ["void", [GoString, GoString, GoString, GoString]],
    PullFromAirgap: ["void", [GoString, GoString, GoString, GoString, GoString, GoString, GoString]],
    RewriteAndPushImageName: ["void", [GoString, GoString, GoString, GoString, GoString, GoString, GoString, GoString]],
    UpdateCheck: ["void", [GoString, GoString]],
    ReadMetadata: ["void", [GoString, GoString]],
    RemoveMetadata: ["void", [GoString, GoString]],
  });
}

export async function kotsAppGetBranding(): Promise<string> {
  const namespace = process.env["POD_NAMESPACE"];
  if (!namespace) {
    throw new Error("unable to determine current namespace");
  }

  const tmpDir = tmp.dirSync();
  try {
    const statusServer = new StatusServer();
    await statusServer.start(tmpDir.name);

    const socketParam = new GoString();
    socketParam["p"] = statusServer.socketFilename;
    socketParam["n"] = statusServer.socketFilename.length;

    const namespaceParam = new GoString();
    namespaceParam["p"] = namespace;
    namespaceParam["n"] = namespace.length;

    let branding = "";
    kots().ReadMetadata(socketParam, namespaceParam);

    await statusServer.connection();
    await statusServer.termination((resolve, reject, obj): boolean => {
      // Return true if completed
      if (obj.status === "terminated") {
        branding = obj.data;
        if (obj.exit_code === 0) {
          resolve();
        } else {
          reject(new Error(`process failed: ${obj.display_message}`));
        }
        return true;
      }
      return false;
    });

    return branding;

  } finally {
    tmpDir.removeCallback();
  }
}

export async function kotsAppCheckForUpdate(currentCursor: string, app: KotsApp, stores: Stores): Promise<boolean> {
  // We need to include the last archive because if there is an update, the ffi function will update it
  const tmpDir = tmp.dirSync();
  const archive = path.join(tmpDir.name, "archive.tar.gz");
  try {
    fs.writeFileSync(archive, await app.getArchive(""+(app.currentSequence!)));

    let isUpdateAvailable = -1;

    const statusServer = new StatusServer();
    await statusServer.start(tmpDir.name);

    const socketParam = new GoString();
    socketParam["p"] = statusServer.socketFilename;
    socketParam["n"] = statusServer.socketFilename.length;

    const archiveParam = new GoString();
    archiveParam["p"] = archive;
    archiveParam["n"] = archive.length;

    kots().UpdateCheck(socketParam, archiveParam);
    await statusServer.connection();
    await statusServer.termination((resolve, reject, obj): boolean => {
      // Return true if completed
      if (obj.status === "terminated") {
        isUpdateAvailable = obj.exit_code;
        if (obj.exit_code !== -1) {
          resolve();
        } else {
          reject(new Error(`process failed: ${obj.display_message}`));
        }
        return true;
      }
      return false;
    });

    if (isUpdateAvailable < 0) {
      console.log("error checking for updates")
      return false;
    }

    if (isUpdateAvailable > 0) {
      // if there was an update available, expect that the new archive is in the smae place as the one we pased in
      const params = await Params.getParams();
      const buffer = fs.readFileSync(archive);
      const newSequence = app.currentSequence! + 1;
      const objectStorePath = path.join(params.shipOutputBucket.trim(), app.id, `${newSequence}.tar.gz`);
      await putObject(params, objectStorePath, buffer, params.shipOutputBucket);

      const cursorAndVersion = await extractCursorAndVersionFromTarball(buffer);
      const supportBundleSpec = await extractSupportBundleSpecFromTarball(buffer);
      const preflightSpec = await extractPreflightSpecFromTarball(buffer);
      const appSpec = await extractAppSpecFromTarball(buffer);
      const kotsAppSpec = await extractKotsAppSpecFromTarball(buffer);
      const appTitle = await extractAppTitleFromTarball(buffer);
      const appIcon = await extractAppIconFromTarball(buffer);

      await stores.kotsAppStore.createMidstreamVersion(app.id, newSequence, cursorAndVersion.versionLabel, cursorAndVersion.cursor, supportBundleSpec, preflightSpec,  appSpec, kotsAppSpec, appTitle, appIcon);

      const clusterIds = await stores.kotsAppStore.listClusterIDsForApp(app.id);
      for (const clusterId of clusterIds) {
        await stores.kotsAppStore.createDownstreamVersion(app.id, newSequence, clusterId, cursorAndVersion.versionLabel, "pending");
      }
    }

    return isUpdateAvailable > 0;
  } finally {
    tmpDir.removeCallback();
  }
}

export async function kotsAppFromLicenseData(licenseData: string, name: string, downstreamName: string, stores: Stores): Promise<KotsApp | void> {
  const parsedLicense = yaml.safeLoad(licenseData);
  if (parsedLicense.spec.isAirgapSupported) {
    try {
      const kotsApp = await stores.kotsAppStore.getPendingKotsAirgapApp();
      return kotsApp;
    } catch(e) {
      console.log("no pending airgap install found, creating a new app");
    }

    const kotsApp = await stores.kotsAppStore.createKotsApp(name, `replicated://${parsedLicense.spec.appSlug}`, licenseData, parsedLicense.spec.isAirgapSupported);
    return kotsApp;
  }

  const kotsApp = await stores.kotsAppStore.createKotsApp(name, `replicated://${parsedLicense.spec.appSlug}`, licenseData, !!parsedLicense.spec.isAirgapSupported);
  await kotsFinalizeApp(kotsApp, downstreamName, stores)

  return kotsApp;
}

export async function kotsFinalizeApp(kotsApp: KotsApp, downstreamName: string, stores: Stores) {
  const tmpDir = tmp.dirSync();

  try {
    const statusServer = new StatusServer();
    await statusServer.start(tmpDir.name);

    const socketParam = new GoString();
    socketParam["p"] = statusServer.socketFilename;
    socketParam["n"] = statusServer.socketFilename.length;

    const licenseDataParam = new GoString();
    licenseDataParam["p"] = kotsApp.license;
    licenseDataParam["n"] = String(kotsApp.license).length;

    const downstreamParam = new GoString();
    downstreamParam["p"] = downstreamName;
    downstreamParam["n"] = downstreamName.length;

    const out = path.join(tmpDir.name, "archive.tar.gz");
    const outParam = new GoString();
    outParam["p"] = out;
    outParam["n"] = out.length;

    kots().PullFromLicense(socketParam, licenseDataParam, downstreamParam, outParam);
    await statusServer.connection();
    await statusServer.termination((resolve, reject, obj): boolean => {
      // Return true if completed
      if (obj.status === "terminated") {
        if (obj.exit_code === 0) {
          resolve();
        } else {
          reject(new Error(`process failed: ${obj.display_message}`));
        }
        return true;
      }
      return false;
    });

    const params = await Params.getParams();
    const buffer = fs.readFileSync(out);

    const objectStorePath = path.join(params.shipOutputBucket.trim(), kotsApp.id, "0.tar.gz");
    await putObject(params, objectStorePath, buffer, params.shipOutputBucket);

    const cursorAndVersion = await extractCursorAndVersionFromTarball(buffer);

    const supportBundleSpec = await extractSupportBundleSpecFromTarball(buffer);
    const preflightSpec = await extractPreflightSpecFromTarball(buffer);
    const appSpec = await extractAppSpecFromTarball(buffer);
    const kotsAppSpec = await extractKotsAppSpecFromTarball(buffer);
    const appTitle = await extractAppTitleFromTarball(buffer);
    const appIcon = await extractAppIconFromTarball(buffer);
    kotsApp.hasPreflight = !!preflightSpec;

    await stores.kotsAppStore.createMidstreamVersion(kotsApp.id, 0, cursorAndVersion.versionLabel, cursorAndVersion.cursor, supportBundleSpec, preflightSpec, appSpec, kotsAppSpec, appTitle, appIcon);

    const downstreams = await extractDownstreamNamesFromTarball(buffer);
    const clusters = await stores.clusterStore.listAllUsersClusters();
    for (const downstream of downstreams) {
      const cluster = _.find(clusters, (c: Cluster) => {
        return c.title === downstream;
      });

      if (!cluster) {
        continue;
      }

      const downstreamState = kotsApp.hasPreflight
        ? "pending_preflight"
        : "deployed";

      await stores.kotsAppStore.createDownstream(kotsApp.id, downstream, cluster.id);
      await stores.kotsAppStore.createDownstreamVersion(kotsApp.id, 0, cluster.id, cursorAndVersion.versionLabel, downstreamState);
    }

    return kotsApp;
  } finally {
    tmpDir.removeCallback();
  }
}

export function kotsPullFromAirgap(socket: string, out: string, app: KotsApp, licenseData: string, airgapDir: string, downstreamName: string, stores: Stores, registryHost: string, registryNamespace: string): any {
  const socketParam = new GoString();
  socketParam["p"] = socket;
  socketParam["n"] = socket.length;

  const licenseDataParam = new GoString();
  licenseDataParam["p"] = licenseData;
  licenseDataParam["n"] = licenseData.length;

  const downstreamParam = new GoString();
  downstreamParam["p"] = downstreamName;
  downstreamParam["n"] = downstreamName.length;

  const airgapDirParam = new GoString();
  airgapDirParam["p"] = airgapDir;
  airgapDirParam["n"] = airgapDir.length;

  const outParam = new GoString();
  outParam["p"] = out;
  outParam["n"] = out.length;

  const registryHostParam = new GoString();
  registryHostParam["p"] = registryHost;
  registryHostParam["n"] = registryHost.length;

  const registryNamespaceParam = new GoString();
  registryNamespaceParam["p"] = registryNamespace;
  registryNamespaceParam["n"] = registryNamespace.length;

  kots().PullFromAirgap(socketParam, licenseDataParam, airgapDirParam, downstreamParam, outParam, registryHostParam, registryNamespaceParam);

  // args are returned so they are not garbage collected before native code is done
  return {
    socketParam,
    licenseDataParam,
    downstreamParam,
    airgapDirParam,
    outParam,
    registryHostParam,
    registryNamespaceParam,
  };
}

export async function kotsAppFromAirgapData(out: string, app: KotsApp, stores: Stores): Promise<{ hasPreflight: Boolean}> {
  const params = await Params.getParams();
  const buffer = fs.readFileSync(out);
  const objectStorePath = path.join(params.shipOutputBucket.trim(), app.id, "0.tar.gz");
  await putObject(params, objectStorePath, buffer, params.shipOutputBucket);

  const cursorAndVersion = await extractCursorAndVersionFromTarball(buffer);
  const supportBundleSpec = await extractSupportBundleSpecFromTarball(buffer);
  const preflightSpec = await extractPreflightSpecFromTarball(buffer);
  const appSpec = await extractAppSpecFromTarball(buffer);
  const kotsAppSpec = await extractKotsAppSpecFromTarball(buffer);
  const appTitle = await extractAppTitleFromTarball(buffer);
  const appIcon = await extractAppIconFromTarball(buffer);

  await stores.kotsAppStore.createMidstreamVersion(app.id, 0, cursorAndVersion.versionLabel, cursorAndVersion.cursor, supportBundleSpec, preflightSpec, appSpec, kotsAppSpec, appTitle, appIcon);

  const downstreams = await extractDownstreamNamesFromTarball(buffer);
  const clusters = await stores.clusterStore.listAllUsersClusters();
  for (const downstream of downstreams) {
    const cluster = _.find(clusters, (c: Cluster) => {
      return c.title === downstream;
    });

    if (!cluster) {
      continue;
    }

    await stores.kotsAppStore.createDownstream(app.id, downstream, cluster.id);
    await stores.kotsAppStore.createDownstreamVersion(app.id, 0, cluster.id, cursorAndVersion.versionLabel, "deployed");
  }

  await stores.kotsAppStore.setKotsAirgapAppInstalled(app.id);

  return {
    hasPreflight: !!preflightSpec
  };
}

export function kotsRewriteAndPushImageName(socket: string, imageFile: string, image: string, format: string, registryHost: string, registryOrg: string, username: string, password: string): any {
  const socketParam = new GoString();
  socketParam["p"] = socket;
  socketParam["n"] = socket.length;

  const imageFileParam = new GoString();
  imageFileParam["p"] = imageFile;
  imageFileParam["n"] = imageFile.length;

  const imageParam = new GoString();
  imageParam["p"] = image;
  imageParam["n"] = image.length;

  const formatParam = new GoString();
  formatParam["p"] = format;
  formatParam["n"] = format.length;

  const registryHostParam = new GoString();
  registryHostParam["p"] = registryHost;
  registryHostParam["n"] = registryHost.length;

  const registryOrgParam = new GoString();
  registryOrgParam["p"] = registryOrg;
  registryOrgParam["n"] = registryOrg.length;

  const usernameParam = new GoString();
  usernameParam["p"] = username;
  usernameParam["n"] = username.length;

  const passwordParam = new GoString();
  passwordParam["p"] = password;
  passwordParam["n"] = password.length;

  kots().RewriteAndPushImageName(socketParam, imageFileParam, imageParam, formatParam, registryHostParam, registryOrgParam, usernameParam, passwordParam);

  // args are returned so they are not garbage collected before native code is done
  return {
    socketParam,
    imageFileParam,
    imageParam,
    formatParam,
    registryHostParam,
    registryOrgParam,
    usernameParam,
    passwordParam,
  };
}
