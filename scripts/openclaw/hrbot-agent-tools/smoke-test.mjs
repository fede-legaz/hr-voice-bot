import {
  hr_get_capabilities,
  hr_list_candidates,
  hr_get_candidate,
  hr_list_calls,
  hr_get_call
} from './hrbot-owner-tools.mjs';

function printStep(label, payload) {
  process.stdout.write(`\n### ${label}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const summary = {
    ok: true,
    steps: []
  };

  const capabilities = await hr_get_capabilities();
  printStep('hr_get_capabilities', capabilities);
  summary.steps.push({
    tool: 'hr_get_capabilities',
    ok: capabilities?.ok === true
  });
  if (capabilities?.ok !== true) {
    throw new Error('Falló hr_get_capabilities');
  }

  const candidates = await hr_list_candidates({ limit: 3 });
  printStep('hr_list_candidates', candidates);
  summary.steps.push({
    tool: 'hr_list_candidates',
    ok: candidates?.ok === true,
    count: candidates?.count || 0
  });
  if (candidates?.ok !== true) {
    throw new Error('Falló hr_list_candidates');
  }

  const candidateId = candidates?.items?.[0]?.id || null;
  if (candidateId) {
    const candidate = await hr_get_candidate({ candidateId });
    printStep('hr_get_candidate', candidate);
    summary.steps.push({
      tool: 'hr_get_candidate',
      ok: candidate?.ok === true,
      candidateId
    });
    if (candidate?.ok !== true) {
      throw new Error(`Falló hr_get_candidate para ${candidateId}`);
    }
  } else {
    summary.steps.push({
      tool: 'hr_get_candidate',
      ok: true,
      skipped: true,
      reason: 'No hay candidatos para probar detalle.'
    });
  }

  const calls = await hr_list_calls({ limit: 3 });
  printStep('hr_list_calls', calls);
  summary.steps.push({
    tool: 'hr_list_calls',
    ok: calls?.ok === true,
    count: calls?.count || 0
  });
  if (calls?.ok !== true) {
    throw new Error('Falló hr_list_calls');
  }

  const callId = calls?.items?.[0]?.callId || null;
  if (callId) {
    const call = await hr_get_call({ callId });
    printStep('hr_get_call', call);
    summary.steps.push({
      tool: 'hr_get_call',
      ok: call?.ok === true,
      callId
    });
    if (call?.ok !== true) {
      throw new Error(`Falló hr_get_call para ${callId}`);
    }
  } else {
    summary.steps.push({
      tool: 'hr_get_call',
      ok: true,
      skipped: true,
      reason: 'No hay calls para probar detalle.'
    });
  }

  printStep('summary', summary);
}

main().catch((error) => {
  const payload = {
    ok: false,
    message: String(error?.message || error)
  };
  printStep('summary', payload);
  process.exitCode = 1;
});
