{{/*
A service's schema migration, as an init container that runs before the service on every pod start
(README.md, "Migrations"). Same image, working directory and command as the one-shot Jobs the
Kustomize deploy ran, wrapped in the advisory lock so replicas take turns. Each reads only its
owner's database URL.

(dict "root" $ "image" <ref> "name" "migrate" "workingDir" "/app/packages/x" "variable" "RYPH_DB"
      "owner" "historian" "secret" "<service secret>" "key" "<key in it>" "ensure" true)

`ensure` creates the database first when it is missing (scripts/ensure_database.ts, race-safe), for
owners added after a server was provisioned.
*/}}
{{- define "ryph.migrate.init" -}}
{{- $root := .root -}}
{{- $ref := include "ryph.db.ref" (list $root .owner .secret .key) | fromJson -}}
{{- $run := printf "bun --no-env-file /ryph-migrate/locked.ts %s bun --no-env-file node_modules/drizzle-kit/bin.cjs migrate" .variable -}}
- name: {{ .name }}
  image: {{ .image }}
  {{- with $root.Values.image.pullPolicy }}
  imagePullPolicy: {{ . }}
  {{- end }}
  workingDir: {{ .workingDir }}
  {{- if .ensure }}
  command:
    - sh
    - -c
    - bun --no-env-file scripts/ensure_database.ts && exec {{ $run }}
  {{- else }}
  command: {{ splitList " " $run | toJson }}
  {{- end }}
  env:
    - name: {{ .variable }}
      valueFrom:
        secretKeyRef:
          name: {{ $ref.name }}
          key: {{ $ref.key }}
    - name: RYPH_MIGRATE_LOCK_TIMEOUT
      value: {{ $root.Values.migrations.lockTimeoutSeconds | default 600 | int | toString | quote }}
  volumeMounts:
    - name: ryph-migrate
      mountPath: /ryph-migrate
      readOnly: true
  resources:
    {{- toYaml $root.Values.migrations.resources | nindent 4 }}
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop: ["ALL"]
{{- end -}}

{{- define "ryph.migrate.volume" -}}
- name: ryph-migrate
  configMap:
    name: ryph-migrate
{{- end -}}
