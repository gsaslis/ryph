{{/*
The Secret contract, in one place. Every service reads a Secret named after itself through envFrom;
README.md lists every key. This file decides each chart-created Secret's data; secrets.yaml writes
them and each Deployment hashes them into a `checksum/secret` annotation, so a changed credential
rolls the pods that read it.
*/}}

{{/* The Secret a service reads: its existingSecret, else the name the chart gives it. */}}
{{- define "ryph.secretName" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- $defaults := dict "controlPlane" "control-plane" "app" "app" "historian" "historian" "memory" "memory" "chat" "chat" "web" "web" "modelProxy" "model-proxy" "mcpGateway" "mcp-gateway" "forge" "forge" "automations" "automations" "egressProxy" "egress-proxy" "previews" "previews" "radicle" "radicle" -}}
{{- (get $root.Values $svc).existingSecret | default (get $defaults $svc) -}}
{{- end -}}

{{/* The namespace role a service's Secret lives in. */}}
{{- define "ryph.secretNamespace" -}}
{{- if eq (index . 1) "egressProxy" -}}
{{ include "ryph.ns.egress" (index . 0) }}
{{- else -}}
{{ include "ryph.ns.services" (index . 0) }}
{{- end -}}
{{- end -}}

{{/*
The internal credentials, and which services' Secrets hold each. A key is resolved once per render:
`secrets.internal.<KEY>` if set, else the value a holder's Secret already has in the cluster
(`lookup`), else a fresh random 64-hex-character value. Every holder gets the same one.

A fresh value is minted only where the chart can tell it is NEW, because a value minted over an
existing one is silent loss: a new sealing key reads nothing the old one sealed. So it refuses,
naming `secrets.internal`, when:

- it cannot see the cluster at all (`helm template`, Argo CD, `--dry-run` without `=server`):
  `lookup` answers empty there, for a deployment that has every Secret as much as for one that has
  none, and every render would mint different values;
- a SEALING key (RYPH_SECRETS_KEY, RYPH_MCP_KEY, RYPH_CHAT_KEY) would be new on an upgrade, or on an
  install where its holder's Deployment already runs (adopting an existing deployment, whose Secret
  has another name): what is in the database was sealed with a key this render does not have;
- a sealing key IS supplied through `secrets.internal` but the cluster's Secret holds another one:
  the supplied value would replace the key everything was sealed with.

`secrets.allowNewSealingKeys` overrides all three, and destroys whatever the old keys sealed.
*/}}
{{- define "ryph.internal.holders" -}}
{{- $h := dict
  "RYPH_FORGE_TOKEN" (list "controlPlane" "forge")
  "RYPH_HISTORY_TOKEN" (list "controlPlane" "historian")
  "RYPH_MODEL_PROXY_TOKEN" (list "controlPlane" "modelProxy")
  "RYPH_MCP_GATEWAY_TOKEN" (list "controlPlane" "mcpGateway")
  "RYPH_AUTOMATIONS_TOKEN" (list "controlPlane" "automations")
  "RYPH_MEMORY_TOKEN" (list "controlPlane" "memory")
  "RYPH_CHAT_TOKEN" (list "controlPlane" "chat")
  "RYPH_PLATFORM_TOKEN" (list "controlPlane" "modelProxy" "memory")
  "RYPH_EGRESS_KEY" (list "controlPlane" "egressProxy")
  "RYPH_PROXY_SECRET" (list "controlPlane" "app")
  "RYPH_MEMORY_GATEWAY_TOKEN" (list "mcpGateway" "memory")
  "RYPH_CHAT_GATEWAY_TOKEN" (list "mcpGateway" "chat")
  "RYPH_WEB_GATEWAY_TOKEN" (list "mcpGateway" "web")
  "RYPH_SECRETS_KEY" (list "modelProxy")
  "RYPH_MCP_KEY" (list "mcpGateway")
  "RYPH_CHAT_KEY" (list "chat")
-}}
{{- if include "ryph.forgeTools" . -}}
{{- $_ := set $h "RYPH_FORGE_GATEWAY_TOKEN" (list "mcpGateway" "forge") -}}
{{- end -}}
{{- if .Values.previews.enabled -}}
{{- $_ := set $h "RYPH_PREVIEWS_TOKEN" (list "previews") -}}
{{- end -}}
{{- if .Values.radicle.enabled -}}
{{- $_ := set $h "RYPH_RADICLE_TOKEN" (list "radicle") -}}
{{- end -}}
{{ toJson $h }}
{{- end -}}

{{/* The keys that seal what users store, and the Deployment holding each. */}}
{{- define "ryph.internal.sealing" -}}
{{ dict "RYPH_SECRETS_KEY" "model-proxy" "RYPH_MCP_KEY" "mcp-gateway" "RYPH_CHAT_KEY" "chat" | toJson }}
{{- end -}}

{{/*
"true" when this render can see the cluster. A LIST, because a list answers even where nothing
exists yet (an empty list is still a list), while `lookup` without a cluster answers {} for
everything; and of the release namespace's Secrets, because that is where Helm itself lists its
release records, so whoever can install the release can read it. A get would not do: Helm renders
before `--create-namespace` creates the namespace, and a NotFound reads exactly like no cluster.
Anything else (Forbidden) aborts the render, so the chart asks only when it would mint.
*/}}
{{- define "ryph.clusterVisible" -}}
{{- if lookup "v1" "Secret" .Release.Namespace "" }}true{{ end -}}
{{- end -}}

{{/*
The values a holder's Secret has for a key in the cluster, if any: (list $ "RYPH_SECRETS_KEY"
<holders>), as a JSON list of the distinct values found. Only chart-created holders are read.
*/}}
{{- define "ryph.internal.inCluster" -}}
{{- $root := index . 0 -}}
{{- $key := index . 1 -}}
{{- $found := list -}}
{{- range (index . 2) -}}
{{- if not (get $root.Values .).existingSecret -}}
{{- $s := lookup "v1" "Secret" (include "ryph.secretNamespace" (list $root .)) (include "ryph.secretName" (list $root .)) -}}
{{- if and $s $s.data (hasKey $s.data $key) -}}
{{- $found = append $found (index $s.data $key | b64dec) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{ $found | uniq | toJson }}
{{- end -}}

{{/*
Resolved once and cached in `.Values.__ryphInternal`, which every template shares. The schema
refuses that key in values (`"__ryphInternal": false`): set by an operator, it would skip every
check above.
*/}}
{{- define "ryph.internal" -}}
{{- if not (hasKey .Values "__ryphInternal") -}}
{{- $root := . -}}
{{- $s := .Values.secrets -}}
{{- $out := dict -}}
{{- $sealing := include "ryph.internal.sealing" . | fromJson -}}
{{- $visible := "" -}}
{{- $probed := false -}}
{{- $missing := list -}}
{{- range $key, $set := ($s.internal | default dict) -}}
{{- if and $set (not $s.allowDevSecrets) (lt (len (toString $set)) 32) -}}
{{- fail (printf "secrets.internal.%s is %d characters; use 32 or more (64 hex characters, say: openssl rand -hex 32). Short values pass only with secrets.allowDevSecrets, on a laptop." $key (len (toString $set))) -}}
{{- end -}}
{{- end -}}
{{- range $key, $holders := (include "ryph.internal.holders" $root | fromJson) -}}
{{- $value := get ($s.internal | default dict) $key -}}
{{- $inCluster := list -}}
{{- if or (not $value) (hasKey $sealing $key) -}}
{{- $inCluster = include "ryph.internal.inCluster" (list $root $key $holders) | fromJsonArray -}}
{{- end -}}
{{- if and $value (hasKey $sealing $key) (not $s.allowNewSealingKeys) -}}
{{- range $inCluster -}}
{{- if ne . (toString $value) -}}
{{- fail (printf "secrets.internal.%s differs from the %s the cluster already holds (Secret %s/%s). %s seals what users stored, and replacing it makes all of that unreadable. Supply the value the cluster holds, or, only on a deployment with nothing sealed, set secrets.allowNewSealingKeys=true." $key $key (include "ryph.ns.services" $root) (get $sealing $key) $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and (not $value) $inCluster -}}
{{- $value = first $inCluster -}}
{{- end -}}
{{- if not $value -}}
{{- $managedByUs := false -}}
{{- range $holders -}}
{{- if not (get $root.Values .).existingSecret }}{{ $managedByUs = true }}{{ end -}}
{{- end -}}
{{- if $managedByUs -}}
{{- if not $s.generate -}}
{{- fail (printf "secrets.internal.%s is not set, the cluster holds none, and secrets.generate is false" $key) -}}
{{- end -}}
{{- if not $s.allowNewSealingKeys -}}
{{- if not $probed -}}
{{- $visible = include "ryph.clusterVisible" $root -}}
{{- $probed = true -}}
{{- end -}}
{{- if not $visible -}}
{{- $missing = append $missing $key -}}
{{- else if hasKey $sealing $key -}}
{{- if $root.Release.IsUpgrade -}}
{{- fail (printf "%s seals what users stored, and no Secret in %s holds it, so this upgrade would mint a new one and everything sealed with the old key would be lost. Supply the existing value through secrets.internal.%s (README.md, \"Moving an existing deployment onto the chart\"). Only on a deployment with nothing sealed, set secrets.allowNewSealingKeys=true." $key (include "ryph.ns.services" $root) $key) -}}
{{- end -}}
{{- if lookup "apps/v1" "Deployment" (include "ryph.ns.services" $root) (get $sealing $key) -}}
{{- fail (printf "%s seals what users stored, and Deployment %s/%s already runs but no chart Secret holds the key: this looks like an existing deployment being adopted. Supply the existing value through secrets.internal.%s (README.md, \"Moving an existing deployment onto the chart\"), or set secrets.allowNewSealingKeys=true to start over without what it sealed." $key (include "ryph.ns.services" $root) (get $sealing $key) $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $value = randAlphaNum 64 | sha256sum -}}
{{- end -}}
{{- end -}}
{{- $_ := set $out $key $value -}}
{{- end -}}
{{- with $missing -}}
{{- fail (printf "this render cannot see the cluster (helm template, Argo CD, --dry-run), so the chart cannot tell whether the deployment already holds these credentials, and minting new ones would replace them: %s. Supply each through secrets.internal (from a sealed or external source) or an existingSecret for every service holding it (README.md, \"Secrets\"), or render with cluster access (helm install/upgrade, or --dry-run=server)." (join ", " .)) -}}
{{- end -}}
{{- $_ := set .Values "__ryphInternal" $out -}}
{{- end -}}
{{ get .Values "__ryphInternal" | toJson }}
{{- end -}}

{{/* Copies the named internal keys into a data dict: (list $ $data (list "RYPH_FORGE_TOKEN" …)). */}}
{{- define "ryph.internal.into" -}}
{{- $i := include "ryph.internal" (index . 0) | fromJson -}}
{{- $data := index . 1 -}}
{{- range (index . 2) }}{{ $_ := set $data . (get $i .) }}{{ end -}}
{{- end -}}

{{/* Adds a database URL unless it lives in a Secret you manage: (list $ $data "historian" "RYPH_HISTORY_DB"). */}}
{{- define "ryph.secret.db" -}}
{{- $url := include "ryph.db.url" (list (index . 0) (index . 2)) -}}
{{- if $url }}{{ $_ := set (index . 1) (index . 3) $url }}{{ end -}}
{{- end -}}

{{/* The S3 keys, for the control plane and the forge. */}}
{{- define "ryph.secret.s3" -}}
{{- $root := index . 0 -}}
{{- $os := $root.Values.objectStore -}}
{{- $id := $os.accessKeyId -}}
{{- $key := $os.secretAccessKey -}}
{{- if and (not $id) (not $os.endpoint) $root.Values.devState.enabled -}}
{{- $id = $root.Values.devState.objects.accessKey -}}
{{- $key = $root.Values.devState.objects.secretKey -}}
{{- end -}}
{{- if and $id (not $os.existingSecret) -}}
{{- $_ := set (index . 1) "RYPH_S3_ACCESS_KEY_ID" $id -}}
{{- $_ := set (index . 1) "RYPH_S3_SECRET_ACCESS_KEY" $key -}}
{{- end -}}
{{- end -}}

{{/*
A chart-created Secret's data, as JSON: (list $ "controlPlane"). Empty when the service uses an
existingSecret.
*/}}
{{- define "ryph.secretData" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- $v := get $root.Values $svc -}}
{{- $d := dict -}}
{{- if eq $svc "controlPlane" -}}
  {{- include "ryph.secret.db" (list $root $d "controlPlane" "RYPH_DB") -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_FORGE_TOKEN" "RYPH_HISTORY_TOKEN" "RYPH_MODEL_PROXY_TOKEN" "RYPH_MCP_GATEWAY_TOKEN" "RYPH_AUTOMATIONS_TOKEN" "RYPH_MEMORY_TOKEN" "RYPH_CHAT_TOKEN" "RYPH_PLATFORM_TOKEN" "RYPH_EGRESS_KEY" "RYPH_PROXY_SECRET")) -}}
  {{- include "ryph.secret.s3" (list $root $d) -}}
{{- else if eq $svc "app" -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_PROXY_SECRET")) -}}
  {{- with $v.assetFallback.accessKeyId }}{{ $_ := set $d "RYPH_ASSET_ACCESS_KEY_ID" . }}{{ end -}}
  {{- with $v.assetFallback.secretAccessKey }}{{ $_ := set $d "RYPH_ASSET_SECRET_ACCESS_KEY" . }}{{ end -}}
{{- else if eq $svc "historian" -}}
  {{- include "ryph.secret.db" (list $root $d "historian" "RYPH_HISTORY_DB") -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_HISTORY_TOKEN")) -}}
{{- else if eq $svc "modelProxy" -}}
  {{- include "ryph.secret.db" (list $root $d "modelProxy" "RYPH_DB") -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_SECRETS_KEY" "RYPH_MODEL_PROXY_TOKEN" "RYPH_PLATFORM_TOKEN")) -}}
{{- else if eq $svc "mcpGateway" -}}
  {{- include "ryph.secret.db" (list $root $d "mcpGateway" "RYPH_DB") -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_MCP_KEY" "RYPH_MCP_GATEWAY_TOKEN" "RYPH_MEMORY_GATEWAY_TOKEN" "RYPH_CHAT_GATEWAY_TOKEN" "RYPH_WEB_GATEWAY_TOKEN")) -}}
  {{- if include "ryph.forgeTools" $root }}{{ include "ryph.internal.into" (list $root $d (list "RYPH_FORGE_GATEWAY_TOKEN")) }}{{ end -}}
{{- else if eq $svc "chat" -}}
  {{- include "ryph.secret.db" (list $root $d "chat" "RYPH_CHAT_DB") -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_CHAT_KEY" "RYPH_CHAT_TOKEN" "RYPH_CHAT_GATEWAY_TOKEN")) -}}
{{- else if eq $svc "web" -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_WEB_GATEWAY_TOKEN")) -}}
  {{- with $v.searchKey }}{{ $_ := set $d "RYPH_WEB_SEARCH_KEY" . }}{{ end -}}
{{- else if eq $svc "memory" -}}
  {{- include "ryph.secret.db" (list $root $d "memory" "RYPH_MEMORY_DB") -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_MEMORY_TOKEN" "RYPH_MEMORY_GATEWAY_TOKEN" "RYPH_PLATFORM_TOKEN")) -}}
{{- else if eq $svc "forge" -}}
  {{- include "ryph.secret.db" (list $root $d "forge" "RYPH_FORGE_DB") -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_FORGE_TOKEN")) -}}
  {{- if include "ryph.forgeTools" $root }}{{ include "ryph.internal.into" (list $root $d (list "RYPH_FORGE_GATEWAY_TOKEN")) }}{{ end -}}
  {{- include "ryph.secret.s3" (list $root $d) -}}
  {{- if $root.Values.github.enabled -}}
    {{- with $root.Values.github.appId }}{{ $_ := set $d "RYPH_GITHUB_APP_ID" (toString .) }}{{ end -}}
    {{- with $root.Values.github.clientId }}{{ $_ := set $d "RYPH_GITHUB_CLIENT_ID" . }}{{ end -}}
    {{- with $root.Values.github.clientSecret }}{{ $_ := set $d "RYPH_GITHUB_CLIENT_SECRET" . }}{{ end -}}
    {{- with $root.Values.github.webhookSecret }}{{ $_ := set $d "RYPH_GITHUB_WEBHOOK_SECRET" . }}{{ end -}}
  {{- end -}}
  {{- if $root.Values.gitlab.enabled -}}
    {{- /* A token in `gitlab.tokenSecret` reaches the pod as its own env entry instead. */ -}}
    {{- if not $root.Values.gitlab.tokenSecret -}}
      {{- with $root.Values.gitlab.token }}{{ $_ := set $d "RYPH_GITLAB_TOKEN" . }}{{ end -}}
    {{- end -}}
    {{- with $root.Values.gitlab.webhookSecret }}{{ $_ := set $d "RYPH_GITLAB_WEBHOOK_SECRET" . }}{{ end -}}
    {{- with $root.Values.gitlab.clientId }}{{ $_ := set $d "RYPH_GITLAB_CLIENT_ID" . }}{{ end -}}
    {{- with $root.Values.gitlab.clientSecret }}{{ $_ := set $d "RYPH_GITLAB_CLIENT_SECRET" . }}{{ end -}}
  {{- end -}}
{{- else if eq $svc "automations" -}}
  {{- include "ryph.secret.db" (list $root $d "automations" "RYPH_AUTOMATIONS_DB") -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_AUTOMATIONS_TOKEN")) -}}
{{- else if eq $svc "egressProxy" -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_EGRESS_KEY")) -}}
{{- else if eq $svc "previews" -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_PREVIEWS_TOKEN")) -}}
{{- else if eq $svc "radicle" -}}
  {{- include "ryph.secret.db" (list $root $d "radicle" "RYPH_RADICLE_DB") -}}
  {{- include "ryph.internal.into" (list $root $d (list "RYPH_RADICLE_TOKEN")) -}}
  {{- /* Empty is a value here, not an omission: an unencrypted key, never a prompt. */ -}}
  {{- $_ := set $d "RAD_PASSPHRASE" ($v.passphrase | default "") -}}
  {{- with $v.alias }}{{ $_ := set $d "RYPH_RADICLE_ALIAS" . }}{{ end -}}
  {{- with $v.connect }}{{ $_ := set $d "RYPH_RADICLE_CONNECT" . }}{{ end -}}
  {{- with $v.externalAddress }}{{ $_ := set $d "RYPH_RADICLE_EXTERNAL_ADDRESS" . }}{{ end -}}
  {{- with $v.explorerUrl }}{{ $_ := set $d "RYPH_RADICLE_EXPLORER_URL" . }}{{ end -}}
{{- end -}}
{{- /* The dev escape hatch: every service refuses a public placeholder unless this is 1. */ -}}
{{- if and $root.Values.secrets.allowDevSecrets (not (has $svc (list "app" "egressProxy"))) -}}
  {{- $_ := set $d "RYPH_ALLOW_DEV_SECRETS" "1" -}}
{{- end -}}
{{- range $k, $val := ($v.extraSecretData | default dict) }}{{ $_ := set $d $k (toString $val) }}{{ end -}}
{{ toJson $d }}
{{- end -}}

{{/* The checksum a pod template carries for its service's Secret: (list $ "controlPlane"). */}}
{{- define "ryph.secretChecksum" -}}
{{- if not (get (index . 0).Values (index . 1)).existingSecret -}}
{{ include "ryph.secretData" . | sha256sum | trunc 16 }}
{{- end -}}
{{- end -}}
