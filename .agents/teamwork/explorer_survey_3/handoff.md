# Git Environment & Worktree Isolation Survey Report

**Author**: `explorer_survey_3`  
**Date**: 2026-11-01  
**Target Branch**: `feat/dev-workflow`  
**Target Repository**: `%USERPROFILE%\Desktop\AI-workflow`  
**Target Worktree Location**: `../AI-workflow-worktrees/feat-dev-workflow` (sibling directory `../AI-workflow-worktrees/feat-dev-workflow`)

---

## 1. Observation

### 1.1 Current Git Status & Tree State
Running `git status` in `%USERPROFILE%\Desktop\AI-workflow` yielded:
```text
On branch feat/p1-amend-actors
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   artifacts/PULL_REQUEST.md
	modified:   artifacts/PostMortem.md
	modified:   artifacts/kanban.json
	modified:   demos/incident-triage-remediation/artifacts/PostMortem.md
	modified:   demos/incident-triage-remediation/artifacts/kanban.json
	modified:   demos/repo-migration-engine/artifacts/PULL_REQUEST.md
	modified:   demos/repo-migration-engine/artifacts/kanban.json

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	.agents/

no changes added to commit (use "git add" and/or "git commit -a")
```
- Current HEAD commit: `3ac56c9` ("merge follow-up: take the evolved scenario-driven facade demo (ours side of the merge)").
- The working tree contains 7 uncommitted modified files and untracked `.agents/`. Developing directly in this tree would risk mixing changes.

### 1.2 Branches & Tracking Configuration
Running `git branch -a` and `git branch -vv`:
```text
  feat/dwf-facade-engine        c11c57c [origin/feat/dwf-facade-engine] test(dwf): compiler, replay, schema-zod and e2e sandbox suites (24 cases)
  feat/facade-script-p0         a37fe01 [origin/feat/facade-script-p0] feat(demo): facade-script edition of the incident triage demo + mock actor-routing
  feat/p0-4-demo-facade         eb45583 [origin/feat/p0-4-demo-facade] feat(demo): incident triage as a dwf facade script (P0-4)
* feat/p1-amend-actors          3ac56c9 merge follow-up: take the evolved scenario-driven facade demo (ours side of the merge)
+ feat/process-supervision      c11c57c (%USERPROFILE%/Desktop/AI-workflow-ps) test(dwf): compiler, replay, schema-zod and e2e sandbox suites (24 cases)
  main                          c0104e0 [origin/main: ahead 1] test(adversarial): harden kiro-pbt stress test and wire into Tier 5 runner
  refactor/engine-deep-overhaul 2894d52 [origin/refactor/engine-deep-overhaul] chore: snapshot WIP engine modules before deep refactor（架构蓝图实施起点）
  remotes/origin/feat/dwf-facade-engine
  remotes/origin/feat/facade-script-p0
  remotes/origin/feat/p0-4-demo-facade
  remotes/origin/main
  remotes/origin/refactor/engine-deep-overhaul
```
- The target branch `feat/dev-workflow` does not exist locally or on remote.
- Local `main` is at `c0104e0`, exactly 1 commit ahead of `origin/main` (`9c7aeaa`).

### 1.3 Worktrees & Workspace Topology
Running `git worktree list --porcelain`:
```text
worktree %USERPROFILE%/Desktop/AI-workflow
HEAD 3ac56c909f86377dff0bd6518acd40f53062b843
branch refs/heads/feat/p1-amend-actors

worktree %USERPROFILE%/Desktop/AI-workflow-ps
HEAD c11c57c37490f0e90344b9c2b39ffe943aa64852
branch refs/heads/feat/process-supervision
```
- A secondary worktree already exists at sibling directory `%USERPROFILE%/Desktop/AI-workflow-ps` on branch `feat/process-supervision`.
- Sibling directories on `Desktop` are the established, proven worktree convention in this environment.

### 1.4 Gitignore State
Inspection of `%USERPROFILE%\Desktop\AI-workflow\.gitignore` (47 lines):
- Contains build outputs (`dist/`, `build/`), temporary files (`*.txt`, `events.jsonl`, `.workflow/`), and `.kiro` rules.
- Does **NOT** contain `.worktrees/` or `.agents/`.
- If a worktree were placed in `.worktrees/feat-dev-workflow` inside the repo root, Git would treat `.worktrees/` as an untracked directory in the parent workspace unless `.gitignore` was modified, dirtying the parent branch.

### 1.5 Remote Connectivity & Push Readiness
1. Running `git remote -v`:
   ```text
   origin	https://github.com/LitaoG/AI-workflow.git (fetch)
   origin	https://github.com/LitaoG/AI-workflow.git (push)
   ```
2. Running `git ls-remote origin`:
   Exited with code 0 in <1s, listing all remote refs (`HEAD`, `refs/heads/main`, `refs/tags/v1.0.0-hackathon`, etc.).
3. Running `git push --dry-run origin main:main`:
   ```text
   To https://github.com/LitaoG/AI-workflow.git
      9c7aeaa..c0104e0  main -> main
   ```
   Exited with code 0.
4. Git configuration shows:
   - `credential.https://github.com.helper=!'C:\Program Files\GitHub CLI\gh.exe' auth git-credential`
   - `http.proxy=http://127.0.0.1:7892`
   - `https.proxy=http://127.0.0.1:7892`
   - `user.name=Litao Gong`
   - `user.email=165118455+LitaoG@users.noreply.github.com`
   Authentication, proxies, and write permissions are fully functional.

### 1.6 Toolchain & Test Environment Notes
- On Windows PowerShell, executing `npm` triggers a security policy error on `npm.ps1` (`UnauthorizedAccess`).
- Executing `npm.cmd run build` and `npm.cmd test` runs cleanly.
- After running `npm.cmd run build` (`tsc`), running `npm.cmd test` executes 88 unit and integration tests across the codebase with `pass 88, fail 0` in ~7 seconds.

---

## 2. Logic Chain

1. **Isolation Justification** (Supported by 1.1 & 1.3):
   Because the main workspace `AI-workflow` currently has dirty unstaged changes on `feat/p1-amend-actors` and untracked `.agents/`, performing the new workflow documentation and configuration inside the main workspace risks accidental staging of unrelated files or git conflict. A separate worktree provides complete physical and index isolation.

2. **Location Selection: Sibling Directory vs Nested** (Supported by 1.3 & 1.4):
   - A nested directory (`.worktrees/feat-dev-workflow`) is not ignored by `.gitignore`. Creating it would dirty the main workspace unless `.gitignore` were edited and committed.
   - A sibling directory at `../AI-workflow-worktrees/feat-dev-workflow` (relative: `../AI-workflow-worktrees/feat-dev-workflow`):
     * Completely decouples the new worktree from `AI-workflow`'s index and ignore files.
     * Prevents file watchers / language servers from indexing duplicate trees.
     * Directly matches the established precedent in the workspace (`%USERPROFILE%/Desktop/AI-workflow-ps`).

3. **Base Branch Selection** (Supported by 1.2 & 1.5):
   Branching from `main` (`c0104e0`) incorporates the stable baseline plus the latest adversarial test hardening. Alternatively, branching from `origin/main` (`9c7aeaa`) is also valid. We recommend `main`.

4. **Remote Push Readiness** (Supported by 1.5):
   Because `git push --dry-run` succeeded with authenticated push access to `https://github.com/LitaoG/AI-workflow.git`, pushing `origin/feat/dev-workflow` with `git push -u origin feat/dev-workflow` will execute smoothly without interactive credential prompts or network blockers.

---

## 3. Caveats

1. **Windows PowerShell Execution Policy**:
   Running `npm` directly inside PowerShell calls `npm.ps1`, which is blocked by default Windows execution policy. All build and test commands must use `npm.cmd` (e.g. `npm.cmd run build`, `npm.cmd test`) or run inside `cmd /c`.
2. **Untracked `.agents/` directory in main workspace**:
   The `.agents/` folder in `%USERPROFILE%\Desktop\AI-workflow` is used for multi-agent coordination metadata. In the new worktree `AI-workflow-worktrees/feat-dev-workflow`, `.agents/` will not be present unless specifically created, keeping the worktree clean for project files.
3. **Existing worktree `AI-workflow-ps`**:
   `%USERPROFILE%/Desktop/AI-workflow-ps` is on branch `feat/process-supervision`. It must remain untouched.

---

## 4. Conclusion & Actionable Implementation Plan

The Git environment is fully prepared and capable of supporting Git Worktree isolation and remote branch pushing.

### Exact Step-by-Step Commands for Implementer

#### Step 1: Create the Isolated Worktree
Run from `%USERPROFILE%\Desktop\AI-workflow`:
```powershell
# Create target parent directory if needed and add worktree with new branch feat/dev-workflow based on main
git worktree add -b feat/dev-workflow ../AI-workflow-worktrees/feat-dev-workflow main
```
*Note: Git creates intermediate directories automatically.*

#### Step 2: Develop and Verify in the Worktree
Run inside `../AI-workflow-worktrees/feat-dev-workflow`:
```powershell
# Navigate into the worktree
cd ../AI-workflow-worktrees/feat-dev-workflow

# Author required files:
# 1. GOVERNANCE.md
# 2. docs/WORKFLOW.md
# 3. Related templates or guides

# Run builds and tests to verify integrity (using npm.cmd for Windows)
npm.cmd run build
npm.cmd test

# Check git status inside worktree
git status

# Stage the new documentation and workflow files
git add GOVERNANCE.md docs/

# Verify staged changes
git diff --staged

# Commit with standard conventional commit message
git commit -m "feat(workflow): establish multi-agent development workflow and governance specs"
```

#### Step 3: Push to Remote Repository
Run inside `../AI-workflow-worktrees/feat-dev-workflow`:
```powershell
# Push branch and set upstream tracking
git push -u origin feat/dev-workflow
```

#### Step 4: Verification & Integrity Checks
Run the following verification commands to ensure criteria are met:
```powershell
# 1. Verify worktree registration
git worktree list

# 2. Verify clean status inside worktree
git -C ../AI-workflow-worktrees/feat-dev-workflow status

# 3. Verify remote branch exists and contains the latest commit
git ls-remote origin refs/heads/feat/dev-workflow
git branch -r | Select-String "feat/dev-workflow"

# 4. Verify main repository remained unpolluted
git -C %USERPROFILE%\Desktop\AI-workflow status
```

---

## 5. Verification Method

To independently verify this survey's conclusions:

1. **Inspect Remotes & Credentials**:
   ```powershell
   git remote -v
   git ls-remote origin
   git push --dry-run origin main:main
   ```
   *Expected*: Code 0, valid output from GitHub with no authentication prompt.
2. **Inspect Existing Worktrees**:
   ```powershell
   git worktree list
   ```
   *Expected*: Lists `AI-workflow` and `AI-workflow-ps`.
3. **Inspect Gitignore Absence of `.worktrees`**:
   ```powershell
   Select-String -Path .gitignore -Pattern "worktree"
   ```
   *Expected*: No matches found (confirming sibling placement is required).
4. **Invalidation Conditions**:
   - If `git push --dry-run origin main:main` returns 403 or 401, GitHub credentials or proxy need refresh.
   - If `git worktree add` fails due to branch name collision, verify with `git branch -a` if `feat/dev-workflow` was created earlier.
