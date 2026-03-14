/**
 * OFS Schema Registry — loads and validates Object/Link/Action type definitions
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ObjectTypeDef, LinkTypeDef, ActionDef } from "./types.js";

// Simple YAML parser for our subset (no dependency needed)
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: result }];

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);
    const content = line.trim();

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    const colonIdx = content.indexOf(":");
    if (colonIdx === -1) continue;

    const key = content.slice(0, colonIdx).trim();
    const rawVal = content.slice(colonIdx + 1).trim();

    if (rawVal === "" || rawVal === "|") {
      // Nested object
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      // Inline array
      parent[key] = rawVal
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim());
    } else if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
      parent[key] = rawVal.slice(1, -1);
    } else if (rawVal === "true") {
      parent[key] = true;
    } else if (rawVal === "false") {
      parent[key] = false;
    } else if (!isNaN(Number(rawVal))) {
      parent[key] = Number(rawVal);
    } else {
      parent[key] = rawVal;
    }
  }
  return result;
}

export class SchemaRegistry {
  private objectTypes = new Map<string, ObjectTypeDef>();
  private linkTypes = new Map<string, LinkTypeDef>();
  private actionDefs = new Map<string, ActionDef>();

  constructor(private ontologyDir: string) {}

  async load(): Promise<void> {
    await Promise.all([this.loadTypes(), this.loadLinks(), this.loadActions()]);
  }

  private async loadTypes(): Promise<void> {
    const dir = path.join(this.ontologyDir, "types");
    if (!fs.existsSync(dir)) return;
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".yaml")) continue;
      const content = await fs.promises.readFile(path.join(dir, file), "utf-8");
      const def = parseSimpleYaml(content) as unknown as ObjectTypeDef;
      if (def.type) this.objectTypes.set(def.type, def);
    }
  }

  private async loadLinks(): Promise<void> {
    const dir = path.join(this.ontologyDir, "links");
    if (!fs.existsSync(dir)) return;
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".yaml")) continue;
      const content = await fs.promises.readFile(path.join(dir, file), "utf-8");
      const def = parseSimpleYaml(content) as unknown as LinkTypeDef;
      if (def.link) this.linkTypes.set(def.link, def);
    }
  }

  private async loadActions(): Promise<void> {
    const dir = path.join(this.ontologyDir, "actions");
    if (!fs.existsSync(dir)) return;
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".sh")) continue;
      const content = await fs.promises.readFile(path.join(dir, file), "utf-8");
      // Parse action metadata from comments
      const name = file.replace(".sh", "");
      const descLine = content.split("\n").find((l) => l.startsWith("# Action:"));
      const desc = descLine?.slice("# Action:".length).trim() ?? name;
      this.actionDefs.set(name, {
        action: name,
        description: desc,
        script: path.join(dir, file),
      });
    }
  }

  getObjectType(name: string): ObjectTypeDef | undefined {
    return this.objectTypes.get(name);
  }

  getLinkType(name: string): LinkTypeDef | undefined {
    return this.linkTypes.get(name);
  }

  getAction(name: string): ActionDef | undefined {
    return this.actionDefs.get(name);
  }

  listObjectTypes(): ObjectTypeDef[] {
    return [...this.objectTypes.values()];
  }

  listLinkTypes(): LinkTypeDef[] {
    return [...this.linkTypes.values()];
  }

  listActions(): ActionDef[] {
    return [...this.actionDefs.values()];
  }

  validateObject(typeName: string, data: Record<string, unknown>): string[] {
    const typeDef = this.objectTypes.get(typeName);
    if (!typeDef) return [`Unknown object type: ${typeName}`];

    const errors: string[] = [];
    for (const [propName, propDef] of Object.entries(typeDef.properties)) {
      if (propDef.required && !(propName in data)) {
        errors.push(`Missing required property: ${propName}`);
      }
    }
    return errors;
  }
}
