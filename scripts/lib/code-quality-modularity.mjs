import path from 'node:path';
import {
  buildRecordMap,
  countPhysicalLines,
  gitText,
  isModularityScopedSourcePath,
  isProtectedHostPath,
  matchRepoPathRule,
  NET_GROWTH_THRESHOLD,
  NON_TEST_FILE_CAP,
  normalizePlanText,
  normalizeRepoPath,
  NO_GROWTH_THRESHOLD,
  parseNumstatRecords,
  PROTECTED_HOST_ADD_CAP,
  PROTECTED_HOST_ALLOWED_ROOTS,
  PROTECTED_HOSTS,
  readCurrentFileText,
  readFileTextAtRef,
  sumShrinkCreditsByParentDir,
} from './code-quality-modularity-shared.mjs';

export {
  countPhysicalLines,
  isModularityScopedSourcePath,
  isProtectedHostPath,
  matchRepoPathRule,
  normalizeRepoPath,
  parseNumstatRecords,
  PROTECTED_HOST_ALLOWED_ROOTS,
  PROTECTED_HOSTS,
} from './code-quality-modularity-shared.mjs';

export async function evaluatePreflightModularityPlan({
  repoRoot,
  touchpoints,
  modularityPlan,
  baseRef = '',
}) {
  const errors = [];
  const touchedProtectedHosts = [];
  const touchedNoGrowthFiles = [];
  const normalizedPlan = normalizePlanText(modularityPlan);
  const rules = Array.isArray(touchpoints) ? touchpoints.map(normalizeRepoPath).filter(Boolean) : [];

  for (const host of PROTECTED_HOSTS) {
    if (!rules.some((rule) => matchRepoPathRule(host, rule))) continue;
    touchedProtectedHosts.push(host);
    if (!normalizedPlan.includes('scripts/lib/')) {
      errors.push(`protected host ${host} requires modularityPlan to reference extraction into scripts/lib/`);
    }
  }

  for (const rule of rules) {
    if (rule.includes('*')) continue;
    if (!isModularityScopedSourcePath(rule)) continue;
    const baseText = readFileTextAtRef(repoRoot, baseRef || 'HEAD', rule);
    if (baseText == null) continue;
    const baselineLineCount = countPhysicalLines(baseText);
    if (baselineLineCount <= NO_GROWTH_THRESHOLD) continue;
    touchedNoGrowthFiles.push(rule);
    if (!/\b(?:shrink|split)\b/i.test(normalizedPlan) && !normalizedPlan.includes('scripts/lib/')) {
      errors.push(`no-growth file ${rule} requires modularityPlan to state shrink-or-split intent`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    evidence: {
      touchedProtectedHosts,
      touchedNoGrowthFiles,
      modularityPlan: normalizedPlan,
    },
  };
}

export const evaluateModularityPlan = evaluatePreflightModularityPlan;

export async function evaluateModularityPolicy({
  repoRoot,
  changedFiles,
  numstatRecords,
  baseRef = '',
}) {
  const errors = [];
  const normalizedChangedFiles = Array.from(
    new Set((Array.isArray(changedFiles) ? changedFiles : []).map(normalizeRepoPath).filter(Boolean)),
  );
  const scopedFiles = normalizedChangedFiles.filter(isModularityScopedSourcePath);
  const numstatByFile = buildRecordMap(numstatRecords);
  const details = [];

  for (const file of scopedFiles) {
    const currentText = await readCurrentFileText(repoRoot, file);
    const currentLineCount = currentText == null ? 0 : countPhysicalLines(currentText);
    const baseText = readFileTextAtRef(repoRoot, baseRef || 'HEAD', file);
    const baselineLineCount = baseText == null ? null : countPhysicalLines(baseText);
    const record = numstatByFile.get(file);
    const added = record?.added ?? (baselineLineCount == null ? currentLineCount : 0);
    const deleted = record?.deleted ?? 0;
    details.push({
      file,
      parentDir: path.posix.dirname(file),
      added,
      deleted,
      netGrowth: Math.max(0, added - deleted),
      currentLineCount,
      baselineLineCount,
      isNewFile: baselineLineCount == null,
      isProtectedHost: isProtectedHostPath(file),
      isNoGrowthFile: baselineLineCount != null && baselineLineCount > NO_GROWTH_THRESHOLD,
    });
  }

  const shrinkCreditsByParentDir = sumShrinkCreditsByParentDir(details);
  const scriptsLibSourceFiles = details
    .filter((detail) => detail.file.startsWith('scripts/lib/') && detail.file !== '')
    .map((detail) => detail.file);

  for (const detail of details) {
    if (detail.isNewFile && detail.currentLineCount > NON_TEST_FILE_CAP) {
      errors.push(`new non-test source file ${detail.file} exceeds ${NON_TEST_FILE_CAP} physical lines`);
    }
    if (detail.isNoGrowthFile && detail.currentLineCount >= Number(detail.baselineLineCount)) {
      errors.push(`no-growth file ${detail.file} must end smaller than baseline (${detail.currentLineCount} >= ${detail.baselineLineCount})`);
    }
    if (!detail.isNewFile && detail.netGrowth > NET_GROWTH_THRESHOLD) {
      const availableShrink = shrinkCreditsByParentDir.get(detail.parentDir) || 0;
      if (availableShrink < detail.netGrowth) {
        errors.push(`source file ${detail.file} net growth ${detail.netGrowth} exceeds ${NET_GROWTH_THRESHOLD} without paired shrink in ${detail.parentDir}`);
      }
    }
    if (!detail.isProtectedHost) continue;
    const allowedRoots = PROTECTED_HOST_ALLOWED_ROOTS[detail.file] || [];
    const hasRequiredExtraction = allowedRoots.some((root) =>
      scriptsLibSourceFiles.some((candidate) => candidate !== detail.file && candidate.startsWith(root)),
    );
    if (!hasRequiredExtraction) {
      errors.push(`protected host ${detail.file} requires a paired module extraction under scripts/lib/`);
    }
    if (detail.baselineLineCount != null && detail.currentLineCount >= detail.baselineLineCount) {
      errors.push(`protected host ${detail.file} must end smaller than baseline`);
    }
    if (detail.added > PROTECTED_HOST_ADD_CAP && !(hasRequiredExtraction && detail.currentLineCount < Number(detail.baselineLineCount))) {
      errors.push(`protected host ${detail.file} added ${detail.added} lines without qualifying extraction offset`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    evidence: {
      scopedFiles,
      protectedHostsTouched: details.filter((detail) => detail.isProtectedHost).map((detail) => detail.file),
      scriptsLibSourceFiles,
      details,
      thresholds: {
        noGrowthBaseline: NO_GROWTH_THRESHOLD,
        newFileCap: NON_TEST_FILE_CAP,
        netGrowthCap: NET_GROWTH_THRESHOLD,
        protectedHostAddCap: PROTECTED_HOST_ADD_CAP,
      },
    },
  };
}

export async function buildModularityGateChecks({
  repoRoot,
  changedFiles,
  numstatRecords,
  baseRef = '',
  gateContractChanged = false,
  rawDiff = '',
  changedFileContents,
  diffTouchesPatterns,
  listMissingCoupledPaths,
}) {
  const checks = [];
  const errors = [];
  const modularityPolicy = await evaluateModularityPolicy({ repoRoot, changedFiles, numstatRecords, baseRef });
  checks.push({
    name: 'modularity-policy',
    passed: modularityPolicy.ok,
    details: modularityPolicy.ok ? 'ok' : modularityPolicy.errors.slice(0, 4).join('; '),
    errorCount: modularityPolicy.errors.length,
  });
  if (!modularityPolicy.ok) errors.push(...modularityPolicy.errors);
  const modularityPolicyChanged =
    changedFiles.includes('scripts/lib/code-quality-modularity.mjs') ||
    changedFiles.includes('scripts/lib/code-quality-modularity-shared.mjs') ||
    (gateContractChanged &&
      diffTouchesPatterns(rawDiff, 'scripts/code-quality-gate.mjs', [
        /modularity-policy/,
        /protected host/,
        /paired shrink/,
        /no-growth/,
      ]));
  if (!modularityPolicyChanged) return { checks, errors };
  const missingPolicyPaths = listMissingCoupledPaths(changedFileContents, [
    'scripts/lib/code-quality-modularity.mjs',
    'scripts/__tests__/code-quality-gate.test.mjs',
    '.codex/skills/cockpit-code-quality-gate/SKILL.md',
    'DECISIONS.md',
    'docs/agentic/DECISIONS_AND_INCIDENTS_TIMELINE.md',
  ]);
  checks.push({
    name: 'modularity-policy-coupling',
    passed: missingPolicyPaths.length === 0,
    details: missingPolicyPaths.length ? `missing coupled files: ${missingPolicyPaths.join(', ')}` : 'ok',
    samplePaths: missingPolicyPaths.slice(0, 10),
  });
  if (missingPolicyPaths.length) errors.push('modularity-policy change requires matching decision/docs/test/skill updates');
  return { checks, errors };
}

export function readNumstatForBaseRef(repoRoot, baseRef = '') {
  const ref = String(baseRef || '').trim();
  const args = ref ? ['diff', '--numstat', `${ref}...HEAD`] : ['diff', '--numstat', 'HEAD'];
  return parseNumstatRecords(gitText(repoRoot, args));
}
