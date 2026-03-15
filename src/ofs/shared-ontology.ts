/**
 * OFS v2 Shared Ontology Layer
 *
 * Manages term-registry.yaml, type-canon/, link-canon/ on a shared path.
 * Agents read-only; proposals go through a review process.
 *
 * Shared path layout:
 *   {sharedPath}/
 *     term-registry.yaml      — semantic anchors (terms + aliases)
 *     type-canon/              — canonical ObjectTypeDef YAML files
 *     link-canon/              — canonical LinkTypeDef YAML files
 *     proposals/               — pending TermProposal JSON files
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { TermEntry, TermProposal, OfsStorage } from "./types.js";

export class SharedOntology {
  private terms: Map<string, TermEntry> = new Map();
  private proposals: Map<string, TermProposal> = new Map();

  constructor(
    private sharedPath: string,
    private storage: OfsStorage | null = null,
  ) {}

  /**
   * Load term registry from disk (YAML-like format, stored as JSON for simplicity).
   */
  async load(): Promise<number> {
    const registryFile = path.join(this.sharedPath, "term-registry.json");
    if (!fs.existsSync(registryFile)) return 0;

    const content = await fs.promises.readFile(registryFile, "utf-8");
    const entries = JSON.parse(content) as TermEntry[];
    this.terms.clear();
    for (const entry of entries) {
      this.terms.set(entry.term, entry);
    }

    // Load pending proposals
    const proposalsDir = path.join(this.sharedPath, "proposals");
    if (fs.existsSync(proposalsDir)) {
      const files = await fs.promises.readdir(proposalsDir);
      for (const file of files.filter((f) => f.endsWith(".json"))) {
        try {
          const p = JSON.parse(
            await fs.promises.readFile(path.join(proposalsDir, file), "utf-8"),
          ) as TermProposal;
          this.proposals.set(p.term, p);
        } catch {
          // skip malformed
        }
      }
    }

    return this.terms.size;
  }

  /**
   * Resolve a term (or alias) to its canonical form.
   */
  resolve(term: string): TermEntry | null {
    // Direct match
    const direct = this.terms.get(term);
    if (direct) return direct;

    // Search aliases
    for (const entry of this.terms.values()) {
      if (entry.aliases.includes(term) || entry.canonical === term) {
        return entry;
      }
    }

    return null;
  }

  /**
   * List all terms.
   */
  listTerms(): TermEntry[] {
    return Array.from(this.terms.values());
  }

  /**
   * Propose a new term (agents can propose; admin accepts).
   */
  async propose(proposal: Omit<TermProposal, "proposed_at" | "status">): Promise<TermProposal> {
    const full: TermProposal = {
      ...proposal,
      proposed_at: new Date().toISOString(),
      status: "pending",
    };

    this.proposals.set(full.term, full);

    // Write to proposals dir
    const proposalsDir = path.join(this.sharedPath, "proposals");
    fs.mkdirSync(proposalsDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(proposalsDir, `${full.term}.json`),
      JSON.stringify(full, null, 2),
    );

    return full;
  }

  /**
   * Accept a proposal — add it to the term registry.
   */
  async acceptProposal(term: string): Promise<TermEntry | null> {
    const proposal = this.proposals.get(term);
    if (!proposal) return null;

    const entry: TermEntry = {
      term: proposal.term,
      canonical: proposal.proposed_canonical,
      aliases: proposal.aliases,
      description: proposal.description,
      source_agent: proposal.proposer_agent,
    };

    this.terms.set(entry.term, entry);
    proposal.status = "accepted";
    this.proposals.delete(term);

    // Persist
    await this.save();
    // Clean up proposal file
    const proposalFile = path.join(this.sharedPath, "proposals", `${term}.json`);
    if (fs.existsSync(proposalFile)) {
      await fs.promises.unlink(proposalFile);
    }

    return entry;
  }

  /**
   * Reject a proposal.
   */
  async rejectProposal(term: string): Promise<boolean> {
    const proposal = this.proposals.get(term);
    if (!proposal) return false;

    proposal.status = "rejected";
    this.proposals.delete(term);

    const proposalFile = path.join(this.sharedPath, "proposals", `${term}.json`);
    if (fs.existsSync(proposalFile)) {
      await fs.promises.unlink(proposalFile);
    }

    return true;
  }

  /**
   * List pending proposals.
   */
  listProposals(): TermProposal[] {
    return Array.from(this.proposals.values());
  }

  /**
   * Save term registry to disk.
   */
  async save(): Promise<void> {
    fs.mkdirSync(this.sharedPath, { recursive: true });
    const registryFile = path.join(this.sharedPath, "term-registry.json");
    const entries = Array.from(this.terms.values());
    await fs.promises.writeFile(registryFile, JSON.stringify(entries, null, 2));

    // Sync to remote storage if available
    if (this.storage) {
      this.storage
        .put("shared/term-registry.json", JSON.stringify(entries, null, 2))
        .catch(() => {});
    }
  }

  /**
   * Sync from remote storage (pull latest shared ontology).
   */
  async syncFromRemote(): Promise<boolean> {
    if (!this.storage) return false;

    try {
      const content = await this.storage.get("shared/term-registry.json");
      if (!content) return false;

      const entries = JSON.parse(content) as TermEntry[];
      this.terms.clear();
      for (const entry of entries) {
        this.terms.set(entry.term, entry);
      }

      // Also write locally
      await this.save();
      return true;
    } catch {
      return false;
    }
  }
}
