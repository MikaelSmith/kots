package kotsadm

import (
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/replicatedhq/kots/pkg/util"
)

func migrationsPod(deployOptions DeployOptions) *corev1.Pod {
	name := fmt.Sprintf("kotsadm-migrations-%d", time.Now().Unix())

	var securityContext corev1.PodSecurityContext
	if !deployOptions.IsOpenShift {
		securityContext = corev1.PodSecurityContext{
			RunAsUser: util.IntPointer(1001),
			FSGroup:   util.IntPointer(1001),
		}
	}

	pod := &corev1.Pod{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "v1",
			Kind:       "Pod",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: deployOptions.Namespace,
		},
		Spec: corev1.PodSpec{
			SecurityContext: &securityContext,
			RestartPolicy:   corev1.RestartPolicyOnFailure,
			Containers: []corev1.Container{
				{
					Image:           fmt.Sprintf("%s/kotsadm-migrations:%s", kotsadmRegistry(), kotsadmTag()),
					ImagePullPolicy: corev1.PullAlways,
					Name:            name,
					Env: []corev1.EnvVar{
						{
							Name:  "SCHEMAHERO_DRIVER",
							Value: "postgres",
						},
						{
							Name:  "SCHEMAHERO_SPEC_FILE",
							Value: "/tables",
						},
						{
							Name: "SCHEMAHERO_URI",
							ValueFrom: &corev1.EnvVarSource{
								SecretKeyRef: &corev1.SecretKeySelector{
									LocalObjectReference: corev1.LocalObjectReference{
										Name: "kotsadm-postgres",
									},
									Key: "uri",
								},
							},
						},
					},
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("20m"),
							corev1.ResourceMemory: resource.MustParse("128Mi"),
						},
						Limits: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("200m"),
							corev1.ResourceMemory: resource.MustParse("256Mi"),
						},
					},
				},
			},
		},
	}

	return pod
}
