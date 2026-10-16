# AgentFlow managed-deployment platform contract

These manifests provide the Kubernetes-side prerequisites for the managed
deployment controller. They are intentionally a deployable baseline, not a
credential bundle or a cluster-specific ingress installation.

## Before applying

1. Build `backend/Dockerfile` and `backend/Dockerfile.runtime`, push both
   images, and replace the two `registry.example/...@sha256:000...` values with
   immutable registry digests. Mutable tags are rejected by the backend.
2. Create `agentflow-backend-config` and `agentflow-provider-credentials` in
   `agentflow-system`. `secrets.example.yaml` documents the key contract but is
   deliberately excluded from `kustomization.yaml`.
3. Change `artifacts.agentflow.example.com` in both the backend environment and
   the Ingress. Install a trusted TLS certificate as
   `agentflow-system/agentflow-artifact-tls`. Runtime pods must trust the
   certificate chain. The artifact endpoint remains bearer-token protected;
   TLS prevents token and bundle disclosure in transit.
4. Confirm the cluster has a default dynamic StorageClass supporting
   `ReadWriteOnce` filesystem claims of at least 5 GiB. Both `Immediate` and
   `WaitForFirstConsumer` binding modes are supported.
5. Deploy the selected no-auth HTTP MCP servers into `mcp-system` and seed
   their stable Service URLs into the MongoDB MCP catalog. They are separate
   workloads and are not bundled into an agent pod.

Apply the baseline with:

```sh
kubectl apply -k deploy/kubernetes
```

## Resource and failure ownership

- The backend ServiceAccount may manage only Deployments, Services, scoped
  runtime Secrets, PVCs, and EndpointSlices in `agentflow-runtimes`. It can
  read only the named provider-credential Secret in `agentflow-system`.
- Each agent or multi-agent publication runs as exactly one pod. Workload
  Deployments use the `Recreate` strategy, and the runtime also claims a
  durable writer fence before opening shared state.
- The PVC identity is stable for the owner plus deployment ID. Undeploy removes
  compute, network Service, and per-generation Secrets but retains the PVC.
  If a previously verified PVC disappears, the controller records
  `storage_missing` and refuses to create an empty replacement.
- The NetworkPolicy permits backend-to-runtime traffic, DNS, the MCP namespace,
  and HTTPS egress for providers and artifact download. Clusters with an egress
  gateway should replace the broad port-443 rule with their gateway policy.
- The Ingress manifest assumes ingress-nginx. Change the class and annotations
  when the cluster uses another implementation; keep the externally observed
  artifact URL HTTPS.

## Deliberately external prerequisites

MongoDB, Redis, the ingress controller, TLS certificate issuance, registry
credentials, and the five MCP server images are environment-specific. This
directory defines their contracts but does not install third-party operators,
databases, or unpinned upstream images.
