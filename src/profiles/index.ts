import bunTypescriptRaw from "../../profiles/bun-typescript.toml";
import reactViteRaw from "../../profiles/react-vite.toml";
import rustRaw from "../../profiles/rust.toml";
import dotnetRaw from "../../profiles/dotnet.toml";
import type { Profile } from "../types.ts";

function asProfile(value: unknown): Profile {
  const profile = value as Profile;
  if (!profile.id || !profile.language || !profile.runtime || !profile.capabilities) {
    throw new Error("Invalid profile definition");
  }
  return profile;
}

const profiles = [bunTypescriptRaw, reactViteRaw, rustRaw, dotnetRaw].map(asProfile);
const byId = new Map(profiles.map((profile) => [profile.id, profile]));

export function getProfile(id: string): Profile {
  const profile = byId.get(id);
  if (!profile) throw new Error(`Unknown profile: ${id}`);
  return profile;
}

export function getProfiles(): Profile[] {
  return [...profiles];
}
