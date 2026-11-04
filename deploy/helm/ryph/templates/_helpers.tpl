{{/* ── names ──────────────────────────────────────────────────────────────────────────────── */}}

{{- define "ryph.chart" -}}
{{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
A namespace of the release, by role: (list $ "runs"). Each defaults to `<prefix>` (services) or
`<prefix>-<role>`. Every cross-namespace reference in the chart goes through here, so two releases
with two prefixes share nothing namespaced.
*/}}
{{- define "ryph.ns" -}}
{{- $root := index . 0 -}}
{{- $role := index . 1 -}}
{{- $ns := $root.Values.namespaces -}}
{{- $explicit := get $ns $role -}}
{{- if $explicit -}}
{{ $explicit }}
{{- else if eq $role "services" -}}
{{ $ns.prefix }}
{{- else -}}
{{ $ns.prefix }}-{{ $role }}
{{- end -}}
{{- end -}}

{{- define "ryph.ns.services" -}}{{ include "ryph.ns" (list . "services") }}{{- end -}}
{{- define "ryph.ns.runs" -}}{{ include "ryph.ns" (list . "runs") }}{{- end -}}
{{- define "ryph.ns.tools" -}}{{ include "ryph.ns" (list . "tools") }}{{- end -}}
{{- define "ryph.ns.builds" -}}{{ include "ryph.ns" (list . "builds") }}{{- end -}}
{{- define "ryph.ns.egress" -}}{{ include "ryph.ns" (list . "egress") }}{{- end -}}
{{- define "ryph.ns.state" -}}{{ include "ryph.ns" (list . "state") }}{{- end -}}

{{/*
A Namespace the chart creates: (list $ "<role>" <its own labels>). Its own labels — the Pod
Security level, the Gateway label — are set last, so `namespaces.labels` can add to them and never
replace one. Kept on uninstall by default (`namespaces.keepOnUninstall`): deleting a namespace
deletes everything in it, in-flight runs, hosted tool servers, build volumes and Secrets included.
*/}}
{{- define "ryph.namespace" -}}
{{- $root := index . 0 -}}
{{- $labels := merge (dict) (index . 2) (dict "app.kubernetes.io/part-of" "ryph") (include "ryph.labels.plain" $root | fromYaml) ($root.Values.namespaces.labels | default dict) }}
apiVersion: v1
kind: Namespace
metadata:
  name: {{ include "ryph.ns" (list $root (index . 1)) }}
  labels:
    {{- toYaml $labels | nindent 4 }}
  {{- if $root.Values.namespaces.keepOnUninstall }}
  annotations:
    helm.sh/resource-policy: keep
  {{- end }}
{{- end -}}

{{/*
Every namespace the release uses resolves to a name of its own, and none is one the cluster owns:
two roles on one namespace would put runs beside the services, or the egress proxy beside the
runs, and every NetworkPolicy would then select across the split.
*/}}
{{- define "ryph.ns.validate" -}}
{{- $root := . -}}
{{- $roles := list "services" "runs" "tools" "builds" "egress" -}}
{{- if .Values.devState.enabled }}{{ $roles = append $roles "state" }}{{ end -}}
{{- $seen := dict -}}
{{- range $role := $roles -}}
{{- $name := include "ryph.ns" (list $root $role) -}}
{{- if has $name (list "default" "kube-system" "kube-public" "kube-node-lease") -}}
{{- fail (printf "namespaces.%s resolves to %q, a namespace the cluster owns; give the release namespaces of its own" $role $name) -}}
{{- end -}}
{{- if hasKey $seen $name -}}
{{- fail (printf "namespaces.%s and namespaces.%s both resolve to %q; every role needs a namespace of its own" (get $seen $name) $role $name) -}}
{{- end -}}
{{- $_ := set $seen $name $role -}}
{{- end -}}
{{- if hasKey (.Values.namespaces.labels | default dict) "ryph.dev/services" -}}
{{- fail "namespaces.labels may not set ryph.dev/services: it is what lets a namespace attach a route to a shared Gateway, and the chart puts it on the services namespace alone" -}}
{{- end -}}
{{- range $k, $_ := (.Values.namespaces.labels | default dict) -}}
{{- if hasPrefix "pod-security.kubernetes.io/" $k -}}
{{- fail (printf "namespaces.labels may not set %s: the chart sets each namespace's Pod Security levels itself, and a *-version key would pin them to an older, weaker definition (enforce-version: v1.0, say)" $k) -}}
{{- end -}}
{{- end -}}
{{- /*
The release namespace holds Helm's release records, and they hold every Secret the chart renders.
It must be none of the namespaces the release uses — the runs, tools, builds or egress namespace
above all — whether or not the chart creates them.
*/ -}}
{{- range $name, $role := $seen -}}
{{- if eq $name $root.Release.Namespace -}}
{{- fail (printf "the release namespace %q is one the release uses (namespaces.%s). Helm keeps its release records there, and they hold every Secret the chart creates. Install the release into a namespace of its own (e.g. -n ryph-system)." $root.Release.Namespace $role) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* A Service's cluster-DNS URL: (list $ "control-plane" "services" 7411). */}}
{{- define "ryph.url" -}}
{{- $root := index . 0 -}}
http://{{ index . 1 }}.{{ include "ryph.ns" (list $root (index . 2)) }}.svc:{{ index . 3 }}
{{- end -}}

{{/*
A hostname's registrable domain, near enough to refuse a previews domain on the app's site: the last
two labels, or three when the last two are a multi-label public suffix this list knows (`co.uk`,
`com.au`, …). It never reads two registrable domains as different when they are the same: two hosts
on one registrable domain always share their last two labels. Under a public suffix the list does
not know (a less common ccTLD's second level, or a private suffix like `github.io`), it can read two
distinct domains as one, and the chart then refuses a pair that was safe. Put such a deployment's
previews under another top-level domain, or add the suffix here.
*/}}
{{- define "ryph.registrableDomain" -}}
{{- $labels := splitList "." (lower (trimSuffix "." .)) -}}
{{- $n := len $labels -}}
{{- $take := 2 -}}
{{- if gt $n 2 }}
{{- $suffix := join "." (slice $labels (sub $n 2)) -}}
{{- if has $suffix (list "co.uk" "org.uk" "ac.uk" "gov.uk" "me.uk" "com.au" "net.au" "org.au" "co.nz" "co.jp" "ne.jp" "or.jp" "co.kr" "com.br" "com.cn" "com.hk" "com.sg" "com.tw" "co.in" "co.za" "com.mx" "com.tr" "co.il") }}
{{- $take = 3 -}}
{{- end }}
{{- end }}
{{- if lt $n $take }}{{ $take = $n }}{{ end -}}
{{- join "." (slice $labels (sub $n $take)) -}}
{{- end -}}

{{/* ── labels ─────────────────────────────────────────────────────────────────────────────── */}}

{{/*
Object labels: (list $ "control-plane"). The first two are what the NetworkPolicies and Services
select on and what the base manifests always carried; the rest are Helm's bookkeeping and appear on
object metadata only, never in a selector or a pod template.
*/}}
{{- define "ryph.labels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/part-of: ryph
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
helm.sh/chart: {{ include "ryph.chart" $root }}
{{- end -}}

{{/* Helm's bookkeeping labels alone, for objects the base gave no labels of their own. */}}
{{- define "ryph.labels.plain" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ include "ryph.chart" . }}
{{- end -}}

{{/* A pod template's labels: exactly the base's two. */}}
{{- define "ryph.podLabels" -}}
app.kubernetes.io/name: {{ . }}
app.kubernetes.io/part-of: ryph
{{- end -}}

{{/* ── images ─────────────────────────────────────────────────────────────────────────────── */}}

{{/* An image reference: (list $ .Values.images.controlPlane). */}}
{{- define "ryph.image" -}}
{{- $root := index . 0 -}}
{{- $img := index . 1 -}}
{{- $registry := $img.registry | default $root.Values.image.registry -}}
{{- $tag := $img.tag | default $root.Values.image.tag | default $root.Chart.AppVersion -}}
{{- if $registry }}{{ trimSuffix "/" $registry }}/{{ end }}{{ $img.repository }}:{{ $tag }}{{ if $img.digest }}@{{ $img.digest }}{{ end }}
{{- end -}}

{{- define "ryph.imagePullSecrets" -}}
{{- with .Values.image.pullSecrets -}}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{/* ── pod scheduling ─────────────────────────────────────────────────────────────────────── */}}

{{/*
nodeSelector, affinity and tolerations for a service pod: (list $ .Values.controlPlane). The
node-failure tolerations come first, as the base's patch put them on every Deployment: leave a dead
node after 30s rather than 300s, because nearly every service here is one replica. The node
controller already waits ~50s of missed heartbeats before it calls a node NotReady, so the whole
gap stays under two minutes; the cost is that after a partition that heals within those seconds the
old pod may still be alive when its replacement starts (the automations service's sweeps take
advisory locks, so a fire is still delivered once).
*/}}
{{- define "ryph.scheduling" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- $nodeSelector := merge (deepCopy ($svc.nodeSelector | default dict)) ($root.Values.podDefaults.nodeSelector | default dict) -}}
{{- with $nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with ($svc.affinity | default $root.Values.podDefaults.affinity) }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- $tolerations := list -}}
{{- if not (kindIs "invalid" $root.Values.nodeFailureTolerationSeconds) -}}
{{- $s := int64 $root.Values.nodeFailureTolerationSeconds -}}
{{- $tolerations = append $tolerations (dict "key" "node.kubernetes.io/not-ready" "operator" "Exists" "effect" "NoExecute" "tolerationSeconds" $s) -}}
{{- $tolerations = append $tolerations (dict "key" "node.kubernetes.io/unreachable" "operator" "Exists" "effect" "NoExecute" "tolerationSeconds" $s) -}}
{{- end -}}
{{- $tolerations = concat $tolerations ($root.Values.podDefaults.tolerations | default list) ($svc.tolerations | default list) -}}
{{- with $tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Pod annotations: (list $ .Values.controlPlane "<checksum>"). */}}
{{- define "ryph.podAnnotations" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- $checksum := index . 2 -}}
{{- $a := merge (deepCopy ($svc.podAnnotations | default dict)) ($root.Values.podDefaults.annotations | default dict) -}}
{{- if $checksum }}{{ $_ := set $a "checksum/secret" $checksum }}{{ end -}}
{{- with $a }}
annotations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* ── the Kubernetes API token ───────────────────────────────────────────────────────────── */}}

{{/*
The control plane and the mcp-gateway call the Kubernetes API with their ServiceAccount's token.
Mounted automatically, it would land in EVERY container of the pod — the migrate init container
and the control plane's sanitizer sidecar included, neither of which has any use for it. So the pod
says `automountServiceAccountToken: false` and mounts exactly what the automount would (a bound
token, the cluster CA, the namespace) into the main container alone, at the path in-cluster clients
read. expirationSeconds 3607 is the automount's own: the kubelet refreshes it, as it would that.
*/}}
{{- define "ryph.apiToken.volume" -}}
- name: kube-api-access
  projected:
    defaultMode: 420 # 0644
    sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3607
      - configMap:
          name: kube-root-ca.crt
          items:
            - key: ca.crt
              path: ca.crt
      - downwardAPI:
          items:
            - path: namespace
              fieldRef:
                apiVersion: v1
                fieldPath: metadata.namespace
{{- end -}}

{{- define "ryph.apiToken.mount" -}}
- name: kube-api-access
  mountPath: /var/run/secrets/kubernetes.io/serviceaccount
  readOnly: true
{{- end -}}

{{/* ── env ────────────────────────────────────────────────────────────────────────────────── */}}

{{/*
Merges a service's env with its extraEnv: (list <env list> <extraEnv list>). A name the chart sets
is replaced in place by the extraEnv entry of the same name; new names are appended in order.
*/}}
{{- define "ryph.env" -}}
{{- $base := index . 0 -}}
{{- $extra := index . 1 | default list -}}
{{- $byName := dict -}}
{{- range $extra }}{{ $_ := set $byName .name . }}{{ end -}}
{{- $out := list -}}
{{- $seen := dict -}}
{{- range $base -}}
{{- if hasKey $byName .name -}}
{{- $out = append $out (get $byName .name) -}}
{{- else -}}
{{- $out = append $out . -}}
{{- end -}}
{{- $_ := set $seen .name true -}}
{{- end -}}
{{- range $extra -}}
{{- if not (hasKey $seen .name) }}{{ $out = append $out . }}{{ end -}}
{{- end -}}
{{- toYaml $out -}}
{{- end -}}

{{/* "on"/"off" from a boolean: always a quoted string in the output. */}}
{{- define "ryph.onOff" -}}{{ ternary "on" "off" (eq (toString .) "true") }}{{- end -}}

{{/* Whether forge tools are on: `forgeTools` auto/true/false. */}}
{{- define "ryph.forgeTools" -}}
{{- $v := toString .Values.forgeTools -}}
{{- if eq $v "auto" -}}
{{- if or .Values.github.enabled .Values.gitlab.enabled .Values.radicle.enabled }}true{{ end -}}
{{- else if eq $v "true" -}}
true
{{- end -}}
{{- end -}}

{{/*
The port the GitLab at `gitlab.url` is served on: the URL's own, else its scheme's.
*/}}
{{- define "ryph.gitlab.port" -}}
{{- $u := urlParse (.Values.gitlab.url | default "https://gitlab.com") -}}
{{- if regexMatch ":[0-9]+$" $u.host -}}
{{ regexFind "[0-9]+$" $u.host }}
{{- else if eq $u.scheme "http" -}}
80
{{- else -}}
443
{{- end -}}
{{- end -}}

{{/*
GitLab's values, refused here rather than by a forge that crash-loops on them: a token to act
with, and in user mode none of the bot's doors (webhooks, sign-in, the group gate), each of which
the forge refuses at boot. With `forge.existingSecret` the credentials are yours to check.
*/}}
{{- define "ryph.gitlab.check" -}}
{{- $g := .Values.gitlab -}}
{{- if and (not $g.token) (not $g.tokenSecret) (not .Values.forge.existingSecret) -}}
{{- fail "gitlab.enabled needs gitlab.token or gitlab.tokenSecret: the token ryph acts on GitLab with" -}}
{{- end -}}
{{- if eq ($g.mode | default "bot") "user" -}}
{{- range $k := list "webhookSecret" "clientId" "clientSecret" "group" -}}
{{- if get $g $k -}}
{{- fail (printf "gitlab.%s is set, but gitlab.mode is user: user mode has no webhooks, sign-in or group" $k) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and (not .Values.forge.existingSecret) (ne (empty $g.clientId) (empty $g.clientSecret)) -}}
{{- fail "a GitLab OAuth application needs both gitlab.clientId and gitlab.clientSecret" -}}
{{- end -}}
{{- if and (include "ryph.gitlab.ca" .) (eq (urlParse ($g.url | default "https://gitlab.com")).scheme "http") -}}
{{- fail "gitlab.caSecret is set, but gitlab.url is http: there is no certificate to trust. Use the instance's https URL, or unset gitlab.caSecret" -}}
{{- end -}}
{{- end -}}

{{/* Whether the forge and memory trust a CA for GitLab: `gitlab.caSecret`, with GitLab on. */}}
{{- define "ryph.gitlab.ca" -}}
{{- if and .Values.gitlab.enabled .Values.gitlab.caSecret.name }}true{{ end -}}
{{- end -}}

{{/*
`gitlab.caSecret`'s PEM, as the forge and memory mount it: its one key, as `ca.pem`, readable by
anyone in the pod — a CA is not a secret, and memory runs without an fsGroup to hand it over.
*/}}
{{- define "ryph.gitlab.caVolume" -}}
- name: gitlab-ca
  secret:
    secretName: {{ .Values.gitlab.caSecret.name }}
    items:
      - key: {{ .Values.gitlab.caSecret.key }}
        path: ca.pem
    defaultMode: 292 # 0444
{{- end -}}

{{- define "ryph.gitlab.caMount" -}}
- name: gitlab-ca
  mountPath: /etc/ryph/gitlab-ca
  readOnly: true
{{- end -}}

{{/* NODE_EXTRA_CA_CERTS adds to the runtime's CAs, so the instance's alone is enough. */}}
{{- define "ryph.gitlab.caEnv" -}}
- name: NODE_EXTRA_CA_CERTS
  value: /etc/ryph/gitlab-ca/ca.pem
{{- end -}}

{{/* Whether something fronts `/v1/hooks/`. */}}
{{- define "ryph.routesHooks" -}}
{{- if or (and .Values.ingress.enabled .Values.ingress.routeHooks) (and .Values.httpRoute.enabled .Values.httpRoute.routeHooks) }}true{{ end -}}
{{- end -}}

{{/* ── state ──────────────────────────────────────────────────────────────────────────────── */}}

{{- define "ryph.objectStore.endpoint" -}}
{{- if .Values.objectStore.endpoint -}}
{{ .Values.objectStore.endpoint }}
{{- else if .Values.devState.enabled -}}
http://objects.{{ include "ryph.ns.state" . }}.svc:9000
{{- else -}}
{{ fail "objectStore.endpoint is required (or devState.enabled for a laptop cluster)" }}
{{- end -}}
{{- end -}}

{{/* S3 credentials from a Secret you manage, as explicit env entries (list $). */}}
{{- define "ryph.objectStore.secretEnv" -}}
{{- with .Values.objectStore.existingSecret }}
- name: RYPH_S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: RYPH_S3_ACCESS_KEY_ID
- name: RYPH_S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: RYPH_S3_SECRET_ACCESS_KEY
{{- end }}
{{- end -}}

{{/*
A database URL for an owner: (list $ "historian"). `postgres.urls.<owner>`, else built from the
server parts. Returns "" when `postgres.urlSecrets.<owner>` names a Secret instead.
*/}}
{{- define "ryph.db.url" -}}
{{- $root := index . 0 -}}
{{- $owner := index . 1 -}}
{{- $pg := $root.Values.postgres -}}
{{- $ref := get ($pg.urlSecrets | default dict) $owner -}}
{{- if and $ref $ref.name -}}
{{- else if get ($pg.urls | default dict) $owner -}}
{{ get $pg.urls $owner }}
{{- else -}}
{{- $host := $pg.host -}}
{{- $user := $pg.user -}}
{{- $password := $pg.password -}}
{{- if and (not $host) $root.Values.devState.enabled -}}
{{- $host = printf "postgres.%s.svc" (include "ryph.ns.state" $root) -}}
{{- $user = $user | default $root.Values.devState.postgres.user -}}
{{- $password = $password | default $root.Values.devState.postgres.password -}}
{{- end -}}
{{- if not $host -}}
{{- fail (printf "postgres.host (or postgres.urls.%s, postgres.urlSecrets.%s, or devState.enabled) is required" $owner $owner) -}}
{{- end -}}
{{- /* An IPv6 address goes in brackets, or its colons read as the port's. */ -}}
{{- if and (contains ":" $host) (not (hasPrefix "[" $host)) }}{{ $host = printf "[%s]" $host }}{{ end -}}
{{- /* urlquery writes a space as "+", which postgres.js's decodeURIComponent keeps as "+": %20. */ -}}
postgres://{{ urlquery $user | replace "+" "%20" }}{{ if $password }}:{{ urlquery $password | replace "+" "%20" }}{{ end }}@{{ $host }}:{{ $pg.port }}/{{ get $pg.databases $owner }}{{ with $pg.params }}?{{ . }}{{ end }}
{{- end -}}
{{- end -}}

{{/*
The env entry that carries an owner's URL when it lives in a Secret you manage:
(list $ "historian" "RYPH_HISTORY_DB"). Empty otherwise — then the service's own Secret has it.
*/}}
{{- define "ryph.db.secretEnv" -}}
{{- $root := index . 0 -}}
{{- $ref := get ($root.Values.postgres.urlSecrets | default dict) (index . 1) -}}
{{- if and $ref $ref.name }}
- name: {{ index . 2 }}
  valueFrom:
    secretKeyRef:
      name: {{ $ref.name }}
      key: {{ $ref.key | default (index . 2) }}
{{- end }}
{{- end -}}

{{/*
Where a migration reads its owner's URL: (list $ "historian" "<service secret>" "<key>"). The
Secret you manage when `postgres.urlSecrets` names one, else the service's own.
*/}}
{{- define "ryph.db.ref" -}}
{{- $root := index . 0 -}}
{{- $ref := get ($root.Values.postgres.urlSecrets | default dict) (index . 1) -}}
{{- if and $ref $ref.name -}}
{{ dict "name" $ref.name "key" ($ref.key | default (index . 3)) | toJson }}
{{- else -}}
{{ dict "name" (index . 2) "key" (index . 3) | toJson }}
{{- end -}}
{{- end -}}
