{{/*
The rules several policies share, each named for what it IS, so a knob that adds to one can never
land on another rule by position (the Kustomize overlays pinned rule indexes with JSON-Patch `test`
ops for exactly that reason).
*/}}

{{/*
DNS, and only to the cluster's resolver. A rule with no `to:` would mean EVERY destination on port
53 — the one hole in the `except` lists: port 53 to the node subnet, to the database's private
address, to any ClusterIP, to the metadata server. So it names its destination like every other
rule. A cluster that answers DNS from a link-local cache (NodeLocal DNSCache) adds that address via
`networkPolicy.dns.extraCidrs`; port 53 to one address opens nothing else of it.
*/}}
{{- define "ryph.netpol.dns" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: {{ .Values.networkPolicy.dns.namespace }}
      podSelector:
        matchLabels:
          {{- toYaml .Values.networkPolicy.dns.podLabels | nindent 10 }}
    {{- range .Values.networkPolicy.dns.extraCidrs }}
    - ipBlock:
        cidr: {{ . }}
    {{- end }}
  ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
{{- end -}}

{{/*
A service's own database: the bundled dev Postgres (devState) by its namespace and label, a server
outside the cluster by `networkPolicy.database.extraCidrs` (its private address falls in a range
every internet rule excepts), and one inside it that an operator runs (CloudNativePG, say) by
`networkPolicy.database.peers`. No peer at all renders no rule: a rule with an empty `to:` would
admit every destination.
*/}}
{{- define "ryph.netpol.database" -}}
{{- $ports := list 5432 -}}
{{- if ne (int .Values.postgres.port) 5432 }}{{ $ports = append $ports (int .Values.postgres.port) }}{{ end -}}
{{- range .Values.networkPolicy.database.extraPorts }}{{ $ports = append $ports (int .) }}{{ end -}}
{{- $peers := list -}}
{{- if .Values.devState.enabled -}}
{{- $peers = append $peers (dict "namespaceSelector" (dict "matchLabels" (dict "kubernetes.io/metadata.name" (include "ryph.ns.state" .))) "podSelector" (dict "matchLabels" (dict "app.kubernetes.io/name" "postgres"))) -}}
{{- end -}}
{{- range .Values.networkPolicy.database.extraCidrs }}{{ $peers = append $peers (dict "ipBlock" (dict "cidr" .)) }}{{ end -}}
{{- $peers = concat $peers (.Values.networkPolicy.database.peers | default list) -}}
{{- if $peers -}}
- to:
    {{- toYaml $peers | nindent 4 }}
  ports:
    {{- range $ports | uniq }}
    - port: {{ . }}
    {{- end }}
{{- end }}
{{- end -}}

{{/*
The public internet: (list $ <except list> <ports or empty>). Every private and link-local range is
excepted (the list is each policy's own, as the base wrote it), plus `networkPolicy.internet.extraExcept`
— public addresses only the cluster knows must stay out of reach, like the API server's endpoint.
*/}}
{{- define "ryph.netpol.internet" -}}
{{- $root := index . 0 -}}
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          {{- range concat (index . 1) ($root.Values.networkPolicy.internet.extraExcept | default list) }}
          - {{ . }}
          {{- end }}
  {{- with (index . 2) }}
  ports:
    {{- range . }}
    - port: {{ . }}
    {{- end }}
  {{- end }}
{{- end -}}

{{/* A run's (or a check's, or a build's) peer: (list $ "<namespace role>" "<label key>" "<label value>"). */}}
{{- define "ryph.netpol.peer" -}}
- namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: {{ include "ryph.ns" (list (index . 0) (index . 1)) }}
  podSelector:
    matchLabels:
      {{ index . 2 }}: {{ index . 3 }}
{{- end -}}

{{/*
The policies `networkPolicy.extraIngress` and `extraEgress` can add to, by name. A key that names
no policy would otherwise be ignored without a word — a rule the operator believes is in force.
*/}}
{{- define "ryph.netpol.validateExtra" -}}
{{- $ingress := list "control-plane" "historian" "memory" "chat" "web" "forge" "automations" "model-proxy" "mcp-gateway" "app" "egress-proxy" "previews" "radicle" -}}
{{- $egress := list "memory" "chat" "web" "model-proxy" "agent-run-egress" "check-run-egress" "environment-build-egress" "egress-proxy" "tool-server" "radicle" -}}
{{- range $k, $_ := (.Values.networkPolicy.extraIngress | default dict) -}}
{{- if not (has $k $ingress) -}}
{{- fail (printf "networkPolicy.extraIngress.%s names no policy; it takes one of: %s" $k (join ", " $ingress)) -}}
{{- end -}}
{{- end -}}
{{- range $k, $_ := (.Values.networkPolicy.extraEgress | default dict) -}}
{{- if not (has $k $egress) -}}
{{- fail (printf "networkPolicy.extraEgress.%s names no policy; it takes one of: %s" $k (join ", " $egress)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Appends networkPolicy.extraIngress/extraEgress for a policy: (list $ "extraIngress" "forge"). */}}
{{- define "ryph.netpol.extra" -}}
{{- with get (get (index . 0).Values.networkPolicy (index . 1)) (index . 2) -}}
{{ toYaml . }}
{{- end -}}
{{- end -}}
