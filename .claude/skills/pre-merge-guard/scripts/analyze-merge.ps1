<#
.SYNOPSIS
  Read-only pre-merge safety analysis of an incoming branch against a base branch.
.DESCRIPTION
  Fetches all branches and reports, WITHOUT merging, what merging <Branch> into
  <Base> would disturb: onboarding-critical files, business logic, views, models/
  migrations, risky deletions (work that would be reverted) and conflict-risk
  overlaps. Detects already-merged, stale, and unrelated-history branches.
  Never runs merge/pull/rebase/cherry-pick/reset.
.PARAMETER Branch
  Incoming branch to analyze. If omitted, tries 'sajeel' then 'sajeeel'.
.PARAMETER Base
  Branch you would merge into. Default 'main'.
#>
[CmdletBinding()]
param(
    [string]$Branch = "",
    [string]$Base   = "main"
)

$ErrorActionPreference = "Stop"

function Head($t, $color = "Cyan") { Write-Host ""; Write-Host ("=" * 72) -ForegroundColor $color; Write-Host $t -ForegroundColor $color; Write-Host ("=" * 72) -ForegroundColor $color }
function NoFs { param([Parameter(ValueFromPipeline)]$l) process { if ($l -notmatch 'fsmonitor') { $l } } }

# ── Repo + fetch ───────────────────────────────────────────────────────────────
$repo = (& git rev-parse --show-toplevel 2>$null)
if (-not $repo) { Write-Error "Not inside a git repository."; exit 1 }

Head "FETCHING (read-only)"
& git fetch --all --prune 2>&1 | NoFs | Out-Host

function Resolve-Ref([string]$name) {
    foreach ($cand in @("origin/$name", $name)) {
        & git rev-parse --verify --quiet ("{0}^{{commit}}" -f $cand) *> $null
        if ($LASTEXITCODE -eq 0) { return $cand }
    }
    return $null
}

if (-not $Branch) {
    foreach ($c in @("sajeel", "sajeeel")) { if (Resolve-Ref $c) { $Branch = $c; break } }
    if (-not $Branch) { Write-Error "No -Branch given and neither 'sajeel' nor 'sajeeel' exists."; exit 1 }
}

$branchRef = Resolve-Ref $Branch
$baseRef   = Resolve-Ref $Base
if (-not $branchRef) { Write-Error "Branch '$Branch' not found locally or on origin."; exit 1 }
if (-not $baseRef)   { Write-Error "Base '$Base' not found locally or on origin."; exit 1 }

$mergeBase = (& git merge-base $baseRef $branchRef 2>$null)
$unrelated = [string]::IsNullOrWhiteSpace($mergeBase)
if (-not $unrelated) { $mergeBase = $mergeBase.Trim() }

if ($unrelated) {
    $incoming = [int](& git rev-list --count $branchRef).Trim()
    $behind   = [int](& git rev-list --count $baseRef).Trim()
    $alreadyMerged = $false
} else {
    $incoming = [int](& git rev-list --count "$mergeBase..$branchRef").Trim()
    $behind   = [int](& git rev-list --count "$mergeBase..$baseRef").Trim()
    & git merge-base --is-ancestor $branchRef $baseRef *> $null
    $alreadyMerged = ($LASTEXITCODE -eq 0)
}

# ── Summary ────────────────────────────────────────────────────────────────────
Head "SUMMARY"
Write-Host ("Incoming branch : {0}  ({1})" -f $branchRef, (& git rev-parse --short $branchRef))
Write-Host ("Base branch     : {0}  ({1})" -f $baseRef,   (& git rev-parse --short $baseRef))
if ($unrelated) {
    Write-Host  "Merge-base      : (none) — UNRELATED HISTORIES" -ForegroundColor Red
} else {
    Write-Host ("Merge-base      : {0}" -f (& git rev-parse --short $mergeBase))
}
Write-Host ("Incoming commits unique to branch : {0}" -f $incoming)
Write-Host ("Base commits since divergence     : {0}" -f $behind)
Write-Host ("Already fully merged into base     : {0}" -f $alreadyMerged)

if ($alreadyMerged -or (-not $unrelated -and $incoming -eq 0)) {
    Head "VERDICT: SAFE - nothing to merge" "Green"
    Write-Host "This branch is fully contained in $Base. No files would change. Nothing to do." -ForegroundColor Green
    exit 0
}

# ── Onboarding-critical path patterns (extend in references/classification.md) ───
$ONBOARD = 'onboard|recipientservice|collectnotifyemails|emailservice|adservice|adsearch\.aspx|adlookup\.aspx|employeejourney|^server\.js$|^src/migrations/'

function Classify([string]$path) {
    $p = $path.ToLower()
    if ($p -match $ONBOARD)                                                                   { return 'ONBOARDING' }
    if ($p -match '\.ejs$')                                                                   { return 'VIEW' }
    if ($p -match '^src/(controllers|services|middleware|routes|utils)/' -or $p -match '\.aspx$' -or $p -eq 'app.js') { return 'LOGIC' }
    if ($p -match '^src/models/')                                                             { return 'MODEL' }
    if ($p -match '^tests/')                                                                  { return 'TEST' }
    if ($p -match '\.md$' -or $p -match '^\.github/' -or $p -match 'package(-lock)?\.json$' -or $p -match 'web\.config$' -or $p -match '\.gitignore$' -or $p -match 'codeowners' -or $p -match 'contributing' -or $p -match '\.config\.') { return 'CONFIG' }
    return 'OTHER'
}

function ExistsInBase([string]$path) {
    & git cat-file -e ("{0}:{1}" -f $baseRef, $path) 2>$null
    return ($LASTEXITCODE -eq 0)
}

# ── Build the change set ─────────────────────────────────────────────────────────
$items = @()

if ($unrelated) {
    # No shared history: a merge would combine two separate trees. Model the impact
    # as: files only in branch = ADDED; files in both that differ = CONFLICT.
    # (Files only in base are kept by a union merge, so they are not "disturbed".)
    $baseFiles = @{}
    foreach ($f in (& git ls-tree -r --name-only $baseRef)) { if ($f) { $baseFiles[$f] = $true } }
    foreach ($f in (& git ls-tree -r --name-only $branchRef)) {
        if (-not $f) { continue }
        $cat = Classify $f
        if ($baseFiles.ContainsKey($f)) {
            & git diff --quiet "$baseRef" "$branchRef" -- $f
            if ($LASTEXITCODE -ne 0) {
                $items += [pscustomobject]@{ Type='Modify'; Cat=$cat; Path=$f; Overlap=$true; RevertsBase=$false }
            }
        } else {
            $items += [pscustomobject]@{ Type='Add'; Cat=$cat; Path=$f; Overlap=$false; RevertsBase=$false }
        }
    }
} else {
    # Shared history: name-status against the merge-base = exactly what the branch did.
    $rawIncoming = & git diff --name-status -M "$mergeBase" "$branchRef"
    # Files base changed since divergence — overlap with these = conflict risk.
    $baseChanged = @{}
    foreach ($f in (& git diff --name-only "$mergeBase" "$baseRef")) { if ($f) { $baseChanged[$f] = $true } }

    foreach ($line in $rawIncoming) {
        if (-not $line) { continue }
        $parts = $line -split "`t"
        $code  = $parts[0]
        $path  = if ($code -like 'R*') { $parts[2] } else { $parts[1] }
        if (-not $path) { continue }
        $type = switch -Regex ($code) { '^A' {'Add'} '^D' {'Delete'} '^R' {'Rename'} '^M' {'Modify'} default {$code} }
        $items += [pscustomobject]@{
            Type        = $type
            Cat         = (Classify $path)
            Path        = $path
            Overlap     = $baseChanged.ContainsKey($path)
            RevertsBase = ($type -eq 'Delete' -and (ExistsInBase $path))
        }
    }
}

$riskyDeletes  = @($items | Where-Object { $_.RevertsBase })
$onboardImpact = @($items | Where-Object { $_.Cat -eq 'ONBOARDING' })
$conflicts     = @($items | Where-Object { $_.Overlap })
$appChanges    = @($items | Where-Object { $_.Cat -in @('ONBOARDING','VIEW','LOGIC','MODEL') })

# Precise conflict list via git merge-tree when supported (git 2.38+). Best-effort.
$mtConflicts = @()
try {
    $mt = & git merge-tree --write-tree --name-only $baseRef $branchRef 2>$null
    if ($LASTEXITCODE -eq 1 -and $mt) {
        $afterBlank = $false
        foreach ($l in $mt) {
            if (-not $afterBlank) { if ($l.Trim() -eq '') { $afterBlank = $true }; continue }
            if ($l.Trim() -eq '') { break }
            $mtConflicts += $l.Trim()
        }
    }
} catch { }

# ── Verdict ──────────────────────────────────────────────────────────────────────
$stale = ($behind -ge 30 -and $riskyDeletes.Count -ge 5)
if ($unrelated) {
    Head "VERDICT: [STOP] DANGEROUS - UNRELATED HISTORIES" "Red"
    Write-Host  "This branch shares NO common history with $Base. A merge would require" -ForegroundColor Red
    Write-Host  "--allow-unrelated-histories and would try to fuse two separate trees." -ForegroundColor Red
    Write-Host ("Files unique to the branch: {0} | Common files that would CONFLICT: {1}" -f (@($items | Where-Object {$_.Type -eq 'Add'}).Count), $conflicts.Count) -ForegroundColor Red
    Write-Host  "Do NOT merge wholesale. If you want its unique additive files, cherry-pick them individually." -ForegroundColor Red
} elseif ($stale) {
    Head "VERDICT: [STOP] DANGEROUS - STALE BRANCH WOULD REVERT CURRENT WORK" "Red"
    Write-Host ("This branch is $behind commits behind $Base and its merge would DELETE $($riskyDeletes.Count) file(s) that still exist on $Base.") -ForegroundColor Red
    Write-Host  "Do NOT merge it wholesale. Take only its unique additive files file-by-file." -ForegroundColor Red
} elseif ($onboardImpact.Count -gt 0 -or $conflicts.Count -gt 0 -or $mtConflicts.Count -gt 0 -or $riskyDeletes.Count -gt 0) {
    Head "VERDICT: [!] REVIEW REQUIRED - touches app code / conflicts" "Yellow"
    Write-Host ("Onboarding-critical: {0} | Conflict-risk: {1} | Risky deletions: {2}" -f $onboardImpact.Count, ([Math]::Max($conflicts.Count,$mtConflicts.Count)), $riskyDeletes.Count) -ForegroundColor Yellow
} elseif ($appChanges.Count -eq 0) {
    Head "VERDICT: [OK] SAFE / ADDITIVE - no app code touched" "Green"
    Write-Host "Only docs/config/tests change. Cherry-picking the specific files is safe if wanted." -ForegroundColor Green
} else {
    Head "VERDICT: [!] REVIEW - app code changes present" "Yellow"
}

# ── Sections ──────────────────────────────────────────────────────────────────────
function Dump($title, $rows, $color) {
    if (-not $rows -or $rows.Count -eq 0) { return }
    Head $title $color
    foreach ($r in $rows) {
        $flags = @()
        if ($r.RevertsBase) { $flags += "DELETES EXISTING" }
        if ($r.Overlap)     { $flags += "CONFLICT-RISK" }
        $tag = if ($flags.Count) { "  [" + ($flags -join ", ") + "]" } else { "" }
        Write-Host ("  {0,-7} {1}{2}" -f $r.Type, $r.Path, $tag)
    }
}

Dump "ONBOARDING-CRITICAL IMPACT  (must not break / revert)" $onboardImpact "Red"
Dump "BUSINESS LOGIC  (controllers / services / middleware / routes / utils / aspx)" (@($items | Where-Object { $_.Cat -eq 'LOGIC' })) "Yellow"
Dump "VIEWS  (.ejs)" (@($items | Where-Object { $_.Cat -eq 'VIEW' })) "Yellow"
Dump "MODELS / MIGRATIONS" (@($items | Where-Object { $_.Cat -eq 'MODEL' })) "Yellow"
Dump "RISKY DELETIONS  (files the merge removes that still exist on $Base)" $riskyDeletes "Red"

if ($mtConflicts.Count -gt 0) {
    Head "PRECISE MERGE CONFLICTS (git merge-tree)" "Red"
    foreach ($c in $mtConflicts) { Write-Host ("  $c") }
} elseif ($conflicts.Count -gt 0) {
    Head "CONFLICT-RISK  (changed on BOTH branches / common files that differ)" "Yellow"
    foreach ($r in $conflicts) { Write-Host ("  {0,-7} {1}" -f $r.Type, $r.Path) }
}

Dump "SAFE / ADDITIVE  (docs / config / tests)" (@($items | Where-Object { $_.Cat -in @('CONFIG','TEST','OTHER') })) "Green"

# ── Next steps ────────────────────────────────────────────────────────────────────
Head "NEXT STEPS (the agent should now do this)"
Write-Host "1. For each ONBOARDING-CRITICAL / BUSINESS LOGIC / VIEW / CONFLICT-RISK file above, open the diff:"
Write-Host ("     git diff {0}...{1} -- <path>      (or: git diff {0} {1} -- <path> for unrelated histories)" -f $Base, $branchRef)
Write-Host "   and explain in plain language what logic/view changes and what could break."
Write-Host "2. Do NOT merge. If only additive files are wanted, recommend cherry-picking just those files."
Write-Host "3. Leave the final merge decision to the user."
Write-Host ""
