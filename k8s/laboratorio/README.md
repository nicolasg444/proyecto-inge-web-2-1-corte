# Laboratorio de recursos (se aplica a mano)

Estos manifiestos **no** se aplican con `kubectl apply -f k8s/` (ese comando
no entra en subcarpetas). Son para provocar fallos a proposito y explicarlos.

| Archivo | Que provoca | Que mirar |
|---|---|---|
| `glotona.yaml` | Reserva 300 MiB con limite de 128 MiB -> **OOMKilled** y `CrashLoopBackOff` | `kubectl -n waytur describe pod glotona` -> `Last State: Terminated, Reason: OOMKilled, Exit Code: 137` |
| `api-gigante.yaml` | Pide 64 CPU -> **Pending** | `kubectl -n waytur describe pod -l app.kubernetes.io/name=api-gigante` -> `0/3 nodes are available: ... Insufficient cpu` |

```bash
kubectl --context kind-waytur apply -f k8s/laboratorio/glotona.yaml
kubectl --context kind-waytur -n waytur get pod glotona -w     # Ctrl+C para salir
kubectl --context kind-waytur delete -f k8s/laboratorio/glotona.yaml

kubectl --context kind-waytur apply -f k8s/laboratorio/api-gigante.yaml
kubectl --context kind-waytur -n waytur get pods -l app.kubernetes.io/name=api-gigante
kubectl --context kind-waytur delete -f k8s/laboratorio/api-gigante.yaml
```

Diferencia clave: **limits** de memoria se hacen cumplir matando el proceso
(OOMKilled); **requests** se hacen cumplir al programar (si no caben, Pending).
La CPU por encima del limite no mata: se frena (throttling).
