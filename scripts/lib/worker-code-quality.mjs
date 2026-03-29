import childProcess from 'node:child_process';
import path from 'node:path';
import { getCockpitRoot } from './agentbus.mjs';
import {
  CODE_QUALITY_HARD_RULE_KEYS,
  readStringField,
} from './worker-code-quality-state.mjs';

export function buildCodeQualityGatePromptBlock({
  codeQualityGate,
  cockpitRoot,
  codeQualityRetryReasonCode = '',
  codeQualityRetryReason = '',
}) {
  if (!codeQualityGate?.required) return '';
  const gateScriptPath = path.join(cockpitRoot || getCockpitRoot(), 'scripts', 'code-quality-gate.mjs');
  const codeQualityCommand = `node "${gateScriptPath}" check --task-kind ${codeQualityGate.taskKind || 'TASK'}`;
  const retryLine = codeQualityRetryReasonCode
    ? `\nRETRY REQUIREMENT:\n` +
      `Your previous output failed runtime code-quality validation.\n` +
      `reasonCode=${codeQualityRetryReasonCode}\n` +
      `detail=${codeQualityRetryReason || 'unspecified'}\n` +
      `Rerun the full code-quality self-review loop, fix the issue, and return corrected output.\n`
    : '';
  return (
    `MANDATORY CODE QUALITY GATE:\n` +
    `Follow the active repo/adapter quality skill guidance already listed above before returning outcome="done".\n` +
    `Run ${codeQualityCommand} before outcome="done".\n` +
    `Then include explicit quality activation evidence in output. Set qualityReview with:\n` +
    `- summary (single-line),\n` +
    `- legacyDebtWarnings (integer),\n` +
    `- hardRuleChecks.{codeVolume,noDuplication,shortestPath,cleanup,anticipateConsequences,simplicity} (single-line concrete notes).\n` +
    `Each other hard-rule note should name the exact cleanup, simplification, or control-path surface you touched.\n` +
    `Runtime enforcement is authoritative: script pass alone is not enough; missing qualityReview evidence rejects outcome="done".\n` +
    `${retryLine}\n`
  );
}

export async function runCodeQualityGateCheck({
  codeQualityGate,
  taskCwd,
  cockpitRoot,
  baseRef = '',
  taskStartHead = '',
  expectedSourceChanges = false,
  scopeIncludeRules = [],
  scopeExcludeRules = [],
  retryCount = 0,
}) {
  const evidence = {
    required: Boolean(codeQualityGate?.required),
    taskKind: readStringField(codeQualityGate?.taskKind) || '',
    requiredKinds: Array.isArray(codeQualityGate?.requiredKinds) ? codeQualityGate.requiredKinds : [],
    command: '',
    executed: false,
    exitCode: null,
    artifactPath: null,
    warningCount: 0,
    scopeMode: 'invalid',
    baseRefUsed: '',
    taskStartHead: readStringField(taskStartHead),
    changedScopeReturned: '',
    changedFilesSample: [],
    sourceFilesSeenCount: 0,
    artifactOnlyChange: false,
    retryCount: Math.max(0, Number(retryCount) || 0),
    scopeIncludeRules: Array.isArray(scopeIncludeRules) ? scopeIncludeRules : [],
    scopeExcludeRules: Array.isArray(scopeExcludeRules) ? scopeExcludeRules : [],
    hardRules: {
      codeVolume: false,
      noDuplication: false,
      shortestPath: false,
      cleanup: false,
      anticipateConsequences: false,
      simplicity: false,
    },
  };
  if (!codeQualityGate?.required) return { ok: true, errors: [], evidence };

  const scriptPath = path.join(cockpitRoot, 'scripts', 'code-quality-gate.mjs');
  const resolvedBaseRef = readStringField(baseRef) || readStringField(taskStartHead);
  evidence.baseRefUsed = resolvedBaseRef;
  evidence.command =
    `node "${scriptPath}" check --task-kind ${evidence.taskKind || 'TASK'}` +
    (resolvedBaseRef ? ` --base-ref ${resolvedBaseRef}` : '');

  const args = [scriptPath, 'check', '--task-kind', evidence.taskKind || 'TASK'];
  if (resolvedBaseRef) args.push('--base-ref', resolvedBaseRef);
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  const timeoutRaw =
    process.env.AGENTIC_CODE_QUALITY_GATE_TIMEOUT_MS ?? process.env.VALUA_CODE_QUALITY_GATE_TIMEOUT_MS ?? '90000';
  const timeoutMs = Math.max(1_000, Number(timeoutRaw) || 90_000);
  let timedOut = false;
  try {
    stdout = childProcess.execFileSync('node', args, {
      cwd: taskCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } catch (err) {
    timedOut = err?.code === 'ETIMEDOUT';
    exitCode = Number(err?.status ?? 1) || 1;
    stdout = String(err?.stdout || '');
    stderr = String(err?.stderr || '');
  }

  let parsed = null;
  {
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const candidate = lines.length > 0 ? lines[lines.length - 1] : '';
    if (candidate) {
      try {
        parsed = JSON.parse(candidate);
      } catch {
        parsed = null;
      }
    }
  }
  const parsedErrors = Array.isArray(parsed?.errors)
    ? parsed.errors.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const parsedWarnings = Array.isArray(parsed?.warnings)
    ? parsed.warnings.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const parsedChangedScope = readStringField(parsed?.changedScope);
  const parsedChangedFilesSample = Array.isArray(parsed?.changedFilesSample)
    ? parsed.changedFilesSample.map((value) => readStringField(value)).filter(Boolean).slice(0, 20)
    : [];
  const parsedSourceFilesCount = Number(parsed?.sourceFilesCount ?? parsed?.sourceFilesSeenCount);
  const parsedArtifactOnlyChange = parsed?.artifactOnlyChange === true;
  const parsedScopeMode = parsedChangedScope.startsWith('commit-range:')
    ? 'commit_range'
    : parsedChangedScope === 'working-tree'
      ? expectedSourceChanges
        ? 'invalid'
        : 'no_code_change'
      : 'invalid';
  evidence.scopeMode = parsedScopeMode;
  evidence.changedScopeReturned = parsedChangedScope;
  evidence.changedFilesSample = parsedChangedFilesSample;
  evidence.sourceFilesSeenCount = Number.isFinite(parsedSourceFilesCount) ? Math.max(0, Math.floor(parsedSourceFilesCount)) : 0;
  evidence.artifactOnlyChange = parsedArtifactOnlyChange;

  const parsedHardRules = parsed?.hardRules && typeof parsed.hardRules === 'object' ? parsed.hardRules : null;
  for (const key of CODE_QUALITY_HARD_RULE_KEYS) {
    evidence.hardRules[key] = parsedHardRules?.[key]?.passed === true;
  }
  const errors = [];
  if (exitCode !== 0) {
    if (parsedErrors.length > 0) {
      errors.push(...parsedErrors);
    } else if (timedOut) {
      errors.push(`code quality gate timed out after ${timeoutMs}ms`);
    } else {
      const stderrTail = String(stderr || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-1)[0];
      errors.push(
        stderrTail
          ? `code quality gate exited with status ${exitCode}: ${stderrTail}`
          : `code quality gate exited with status ${exitCode}`,
      );
    }
  }

  if (expectedSourceChanges && !resolvedBaseRef) {
    errors.push('missing_base_ref');
  }
  if (expectedSourceChanges && resolvedBaseRef && parsedScopeMode === 'invalid') {
    errors.push('scope_invalid');
  } else if (expectedSourceChanges && resolvedBaseRef && parsedScopeMode !== 'commit_range') {
    errors.push('scope_mismatch');
  }
  if (expectedSourceChanges && parsedArtifactOnlyChange) {
    errors.push('artifact_only_mismatch');
  }
  if (exitCode === 0) {
    if (!parsedHardRules) {
      errors.push('code quality gate missing hardRules evidence');
    } else {
      for (const key of CODE_QUALITY_HARD_RULE_KEYS) {
        if (parsedHardRules?.[key]?.passed !== true) {
          errors.push(`hard rule not satisfied: ${key}`);
        }
      }
    }
  }

  return {
    ok: exitCode === 0 && errors.length === 0,
    errors,
    evidence: {
      ...evidence,
      executed: true,
      exitCode,
      artifactPath: readStringField(parsed?.artifactPath) || null,
      warningCount: parsedWarnings.length,
    },
  };
}

export function validateCodeQualityReviewEvidence({ parsed, codeQualityGate }) {
  const evidence = {
    required: Boolean(codeQualityGate?.required),
    present: false,
    summary: '',
    legacyDebtWarnings: null,
    hardRuleChecks: Object.fromEntries(CODE_QUALITY_HARD_RULE_KEYS.map((key) => [key, false])),
  };
  if (!codeQualityGate?.required) return { ok: true, errors: [], evidence };

  const errors = [];
  const qualityReview = parsed?.qualityReview && typeof parsed.qualityReview === 'object' ? parsed.qualityReview : null;
  evidence.present = Boolean(qualityReview);
  if (!qualityReview) {
    errors.push('qualityReview evidence is required');
    return { ok: false, errors, evidence };
  }

  const summary = readStringField(qualityReview.summary);
  evidence.summary = summary;
  if (!summary) {
    errors.push('qualityReview.summary is required');
  } else if (/[\r\n]/.test(summary)) {
    errors.push('qualityReview.summary must be single-line');
  }

  const legacyDebtWarnings = qualityReview.legacyDebtWarnings;
  if (typeof legacyDebtWarnings !== 'number' || !Number.isInteger(legacyDebtWarnings) || legacyDebtWarnings < 0) {
    errors.push('qualityReview.legacyDebtWarnings must be a non-negative integer');
  } else {
    evidence.legacyDebtWarnings = legacyDebtWarnings;
  }

  const hardRuleChecks =
    qualityReview.hardRuleChecks && typeof qualityReview.hardRuleChecks === 'object'
      ? qualityReview.hardRuleChecks
      : null;
  if (!hardRuleChecks) {
    errors.push('qualityReview.hardRuleChecks is required');
    return { ok: false, errors, evidence };
  }

  for (const key of CODE_QUALITY_HARD_RULE_KEYS) {
    const note = readStringField(hardRuleChecks[key]);
    evidence.hardRuleChecks[key] = Boolean(note);
    if (!note) {
      errors.push(`qualityReview.hardRuleChecks.${key} is required`);
      continue;
    }
    if (/[\r\n]/.test(note)) {
      errors.push(`qualityReview.hardRuleChecks.${key} must be single-line`);
    }
    if (note.length > 200) {
      errors.push(`qualityReview.hardRuleChecks.${key} must be <=200 chars`);
    }
  }

  return { ok: errors.length === 0, errors, evidence };
}
