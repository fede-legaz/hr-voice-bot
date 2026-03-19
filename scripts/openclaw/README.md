# OpenClaw sobre HRBOT

## Qué hace

Este plugin nativo conecta OpenClaw con HRBOT por API.

- No scrapea la UI.
- No hace browser automation.
- Lee capabilities, candidatos y calls desde los endpoints reales de HRBOT.
- Reusa el sistema nativo de plugins de OpenClaw.

## Archivos del plugin

Quedó armado en:

- `/Users/fedelegaz/projects/HRBOT/scripts/openclaw/hrbot-agent-tools/hrbot-owner-tools.mjs`
- `/Users/fedelegaz/projects/HRBOT/scripts/openclaw/hrbot-agent-tools/index.mjs`
- `/Users/fedelegaz/projects/HRBOT/scripts/openclaw/hrbot-agent-tools/openclaw.plugin.json`
- `/Users/fedelegaz/projects/HRBOT/scripts/openclaw/hrbot-agent-tools/package.json`
- `/Users/fedelegaz/projects/HRBOT/scripts/openclaw/hrbot-agent-tools/smoke-test.mjs`

## Variables de entorno

Definí estas variables donde corre OpenClaw:

```bash
HRBOT_BASE_URL=https://lobster-app-68eq9.ondigitalocean.app
HRBOT_AGENT_TOKEN=REEMPLAZAR_CON_TOKEN_REAL
```

## Tools disponibles

- `hr_get_capabilities`
- `hr_list_candidates`
- `hr_get_candidate`
- `hr_list_calls`
- `hr_get_call`

## Instalación real en el droplet de OpenClaw

Ruta nativa detectada:

- plugins locales: `/root/.openclaw/local-plugins`
- config principal: `/root/.openclaw/openclaw.json`
- env files: `/root/.config/openclaw`
- servicio: `openclaw-gateway.service`

### 1. Copiar el plugin al droplet

```bash
scp -r /Users/fedelegaz/projects/HRBOT/scripts/openclaw/hrbot-agent-tools root@142.93.71.213:/root/.openclaw/local-plugins/
```

### 2. Crear el env del plugin

```bash
ssh root@142.93.71.213 "cat > /root/.config/openclaw/hrbot-agent.env <<'EOF'
HRBOT_BASE_URL=https://lobster-app-68eq9.ondigitalocean.app
HRBOT_AGENT_TOKEN=REEMPLAZAR_CON_TOKEN_REAL
EOF"
```

### 3. Cargar ese env en el gateway

```bash
ssh root@142.93.71.213 "mkdir -p /root/.config/systemd/user/openclaw-gateway.service.d && cat > /root/.config/systemd/user/openclaw-gateway.service.d/hrbot-agent.conf <<'EOF'
[Service]
EnvironmentFile=-/root/.config/openclaw/hrbot-agent.env
EOF"
```

### 4. Registrar el plugin en OpenClaw

```bash
ssh root@142.93.71.213 "python3 - <<'PY'
import json
from pathlib import Path

path = Path('/root/.openclaw/openclaw.json')
data = json.loads(path.read_text())

plugin_id = 'hrbot-agent-tools'
plugin_path = '/root/.openclaw/local-plugins/hrbot-agent-tools'

plugins = data.setdefault('plugins', {})
load = plugins.setdefault('load', {})
paths = load.setdefault('paths', [])
if plugin_path not in paths:
    paths.append(plugin_path)

entries = plugins.setdefault('entries', {})
entries[plugin_id] = {'enabled': True}

installs = plugins.setdefault('installs', {})
installs[plugin_id] = {
    'source': 'path',
    'sourcePath': plugin_path,
    'installPath': plugin_path,
    'version': '0.0.1'
}

path.write_text(json.dumps(data, indent=2) + '\n')
print('ok')
PY"
```

### 5. Reiniciar OpenClaw

```bash
ssh root@142.93.71.213 "systemctl --user daemon-reload && systemctl --user restart openclaw-gateway.service && systemctl --user status openclaw-gateway.service --no-pager -l | sed -n '1,80p'"
```

## Smoke tests

### Sintaxis local

```bash
node --check /Users/fedelegaz/projects/HRBOT/scripts/openclaw/hrbot-agent-tools/hrbot-owner-tools.mjs
node --check /Users/fedelegaz/projects/HRBOT/scripts/openclaw/hrbot-agent-tools/index.mjs
node --check /Users/fedelegaz/projects/HRBOT/scripts/openclaw/hrbot-agent-tools/smoke-test.mjs
```

### Smoke test HTTP desde el droplet

```bash
ssh root@142.93.71.213 "set -a && source /root/.config/openclaw/hrbot-agent.env && set +a && node /root/.openclaw/local-plugins/hrbot-agent-tools/smoke-test.mjs"
```

### Smoke tests por endpoint

```bash
curl -H "Authorization: Bearer $HRBOT_AGENT_TOKEN" "$HRBOT_BASE_URL/openclaw/capabilities"
```

```bash
curl -H "Authorization: Bearer $HRBOT_AGENT_TOKEN" "$HRBOT_BASE_URL/admin/cv?limit=5"
```

```bash
curl -H "Authorization: Bearer $HRBOT_AGENT_TOKEN" "$HRBOT_BASE_URL/admin/calls?limit=5"
```

## Resultado esperado

Si todo quedó bien:

1. `openclaw-gateway.service` queda `active (running)`.
2. `smoke-test.mjs` devuelve `ok: true` en capabilities y listados.
3. Si hay data real, también pasa `hr_get_candidate` y `hr_get_call`.
4. OpenClaw ve las 5 tools nuevas del plugin `hrbot-agent-tools`.

## Riesgos reales

1. Si `HRBOT_AGENT_TOKEN` es incorrecto, todo va a devolver `401`.
2. Si el plugin está copiado pero no registrado en `openclaw.json`, OpenClaw no lo va a cargar.
3. Si no reiniciás `openclaw-gateway.service`, el plugin puede no aparecer hasta el próximo restart.
