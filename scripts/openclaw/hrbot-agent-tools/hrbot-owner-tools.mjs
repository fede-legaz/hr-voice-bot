const DEFAULT_TIMEOUT_MS = 15000;

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function requireEnv(name, fallbackNames = []) {
  const names = [name, ...fallbackNames];
  for (const key of names) {
    const value = readEnv(key);
    if (value) return value;
  }
  throw new Error(`Falta variable de entorno: ${names.join(' / ')}`);
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function optionalString(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return raw;
}

function requiredString(value, fieldName) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`Falta ${fieldName}.`);
  return raw;
}

function optionalInteger(value, fieldName, min = 1, max = 200) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${fieldName} debe ser un entero entre ${min} y ${max}.`);
  }
  return parsed;
}

function optionalNumber(value, fieldName, min = 0) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${fieldName} debe ser un número válido mayor o igual a ${min}.`);
  }
  return parsed;
}

function buildHeaders() {
  const token = requireEnv('HRBOT_AGENT_TOKEN', ['HRBOT_TOKEN']);
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-agent-source': 'openclaw'
  };
}

async function hrbotRequest(pathname, options = {}) {
  const baseUrl = normalizeBaseUrl(requireEnv('HRBOT_BASE_URL', ['HRBOT_AGENT_BASE_URL']));
  const url = new URL(`${baseUrl}${pathname}`);
  const query = options.query || {};

  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: buildHeaders(),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const message = String(payload?.message || payload?.error || `HRBOT respondió ${response.status}`);
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

function summarizeError(error) {
  return {
    ok: false,
    message: String(error?.message || 'No se pudo completar la operación.'),
    status: Number(error?.status || 500),
    details: error?.payload || null
  };
}

export const OPENCLAW_HRBOT_AGENT_INSTRUCTIONS = [
  'Usá HRBOT como sistema maestro para recruiting.',
  'Estas tools son solo de lectura: capabilities, candidatos y calls.',
  'Si necesitás más contexto, empezá por hr_get_capabilities.',
  'Para detalle puntual, usá hr_get_candidate o hr_get_call con IDs reales devueltos por los listados.',
  'Respondé corto, operativo y sin inventar datos.'
].join(' ');

export const TOOLS = [
  {
    name: 'hr_get_capabilities',
    description: 'Lee las capacidades expuestas por HRBOT para OpenClaw.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'hr_list_candidates',
    description: 'Lista candidatos/CVs desde HRBOT con filtros reales del admin.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        brand: { type: 'string' },
        role: { type: 'string' },
        limit: { type: 'integer' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'hr_get_candidate',
    description: 'Trae un candidato puntual por ID desde HRBOT.',
    input_schema: {
      type: 'object',
      properties: {
        candidateId: { type: 'string' }
      },
      required: ['candidateId'],
      additionalProperties: false
    }
  },
  {
    name: 'hr_list_calls',
    description: 'Lista entrevistas/calls desde HRBOT con filtros reales del admin.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        brand: { type: 'string' },
        role: { type: 'string' },
        recommendation: { type: 'string' },
        minScore: { type: 'number' },
        maxScore: { type: 'number' },
        limit: { type: 'integer' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'hr_get_call',
    description: 'Trae una entrevista/call puntual por ID desde HRBOT.',
    input_schema: {
      type: 'object',
      properties: {
        callId: { type: 'string' }
      },
      required: ['callId'],
      additionalProperties: false
    }
  }
];

export async function hr_get_capabilities() {
  try {
    return await hrbotRequest('/openclaw/capabilities', { method: 'GET' });
  } catch (error) {
    return summarizeError(error);
  }
}

export async function hr_list_candidates(input = {}) {
  try {
    const result = await hrbotRequest('/admin/cv', {
      method: 'GET',
      query: {
        q: optionalString(input.q, 'q'),
        brand: optionalString(input.brand, 'brand'),
        role: optionalString(input.role, 'role'),
        limit: optionalInteger(input.limit, 'limit')
      }
    });

    const items = Array.isArray(result?.cvs) ? result.cvs : [];
    return {
      ok: true,
      count: items.length,
      items
    };
  } catch (error) {
    return summarizeError(error);
  }
}

export async function hr_get_candidate(input = {}) {
  try {
    const candidateId = requiredString(input.candidateId ?? input.id, 'candidateId');
    const result = await hrbotRequest(`/openclaw/cv/${encodeURIComponent(candidateId)}`, {
      method: 'GET'
    });
    return {
      ok: true,
      candidate: result?.cv || null
    };
  } catch (error) {
    return summarizeError(error);
  }
}

export async function hr_list_calls(input = {}) {
  try {
    const result = await hrbotRequest('/admin/calls', {
      method: 'GET',
      query: {
        q: optionalString(input.q, 'q'),
        brand: optionalString(input.brand, 'brand'),
        role: optionalString(input.role, 'role'),
        recommendation: optionalString(input.recommendation, 'recommendation'),
        minScore: optionalNumber(input.minScore, 'minScore'),
        maxScore: optionalNumber(input.maxScore, 'maxScore'),
        limit: optionalInteger(input.limit, 'limit')
      }
    });

    const items = Array.isArray(result?.calls) ? result.calls : [];
    return {
      ok: true,
      count: items.length,
      items
    };
  } catch (error) {
    return summarizeError(error);
  }
}

export async function hr_get_call(input = {}) {
  try {
    const callId = requiredString(input.callId ?? input.id, 'callId');
    const result = await hrbotRequest(`/openclaw/calls/${encodeURIComponent(callId)}`, {
      method: 'GET'
    });
    return {
      ok: true,
      call: result?.call || null
    };
  } catch (error) {
    return summarizeError(error);
  }
}
