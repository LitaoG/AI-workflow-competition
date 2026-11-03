# Specification: Durable State & Replay Invariants

## 1. Formal State Reconstruction Model
The durable execution state of an AI-Workflow run at any step checkpoint $k \in [0, N]$ is defined as a deterministic fold over the append-only event stream:

$$\text{State}(k) = \text{Fold}(\text{InitContext}, \text{Events}[0..k])$$

Where $\text{Fold}(S, E)$ processes state mutations in strict monotonic sequence order:
$$\forall i \in [1, k], \quad \text{Seq}(E_i) = \text{Seq}(E_{i-1}) + 1$$

## 2. Invariant Properties
1. **Idempotent Prefix Caching**:
   For any step $s \in \text{Workflow}$ where $\text{checkpoint}(s).\text{status} = \text{'completed'}$:
   $$\text{eval}(s) \equiv \text{checkpoint}(s).\text{output}$$
   Execution of step $s$ is skipped, and LLM token expenditure is guaranteed to be 0.

2. **Monotonic Sequence Ordering**:
   Event log writes to `events.jsonl` are atomic and assign strictly monotonically increasing integers to `sequence`:
   $$\forall i < j \implies \text{sequence}(E_i) < \text{sequence}(E_j)$$

3. **Failure Isolation & Resumption**:
   When a step $s_f$ fails, execution halts cleanly. Resuming via `--resume-from-failed`:
   - Preserves all completed checkpoints $\{ s \mid s \prec s_f \}$.
   - Invalidates checkpoints $\{ s \mid s_f \preceq s \}$.
   - Re-executes beginning exactly at $s_f$.

4. **Crash Tolerance**:
   If an operating system crash interrupts writing mid-line to `events.jsonl`, `EventLogReader` automatically detects and skips corrupted terminal lines, while SQLite WAL mode ensures transactional step integrity.
