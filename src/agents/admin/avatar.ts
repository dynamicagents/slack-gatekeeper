import { env } from "cloudflare:workers";
import { AVATAR_IMAGE_MODEL_ID } from "@/config";

/** A generated avatar: raw image bytes plus the MIME type to serve them under. */
export interface GeneratedImage {
  data: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface AvatarPromptInput {
  /** The workspace this admin agent belongs to — anchors the avatar's identity. */
  workspaceName: string;
  /** Optional extra art direction from the admin/user (style, colors, motifs). */
  instructions?: string;
}

/**
 * Compose the text-to-image prompt for an admin avatar. The workspace name grounds
 * the result in the team it represents; any caller-supplied `instructions` are
 * folded in as additional art direction.
 */
export function buildAvatarPrompt(input: AvatarPromptInput): string {
  const base =
    `A clean, modern square slack avatar for the "${input.workspaceName}" team's ` +
    `admin assistant — a friendly, professional mascot or emblem. ` +
    `It must have a robot face or head, but not be a literal human.`;
  const direction = input.instructions?.trim();
  const style =
    "Flat vector style, bold simple shapes, centered composition, solid background, " +
    "no text, no lettering.";
  return [base, direction, style].filter(Boolean).join(" ");
}

export interface AgentAvatarPromptInput {
  /** The custom agent's machine name (slug) — the fallback subject. */
  agentName: string;
  /** The agent's human display name, preferred as the avatar's subject when set. */
  displayName?: string | null;
  /** Optional extra art direction from the admin/user (style, colors, motifs). */
  instructions?: string;
}

/**
 * Compose the text-to-image prompt for a custom agent's avatar. Anchored on the
 * agent's display name (or machine name), NOT the "admin assistant" wording used
 * for {@link buildAvatarPrompt} — a custom agent is a distinct persona.
 */
export function buildAgentAvatarPrompt(input: AgentAvatarPromptInput): string {
  const subject = input.displayName?.trim() || input.agentName;
  const base =
    `A clean, modern square slack avatar for an AI assistant named "${subject}" — ` +
    `a friendly, distinctive mascot or emblem representing this agent's persona.`;
  const direction = input.instructions?.trim();
  const style =
    "Flat vector style, bold simple shapes, centered composition, solid background, " +
    "no text, no lettering.";
  return [base, direction, style].filter(Boolean).join(" ");
}

/**
 * Generate an avatar via Workers AI. Isolated here (as `@/agents/model` isolates
 * the chat model) so the AI binding call is the only impure part. FLUX.2 returns
 * the image as a base64-encoded JPEG in `{ image }`; we decode it to bytes for DO
 * storage.
 */
export async function generateAvatar(prompt: string): Promise<GeneratedImage> {
  // FLUX.2 klein takes a multipart form input (not plain JSON). FormData doesn't
  // expose its serialized body or boundary, so we run it through a Response to get the
  // body stream + the Content-Type header (with boundary) the model needs to parse the
  // fields. 512×512 is Slack's recommended avatar size.
  //
  // NB: this call deliberately does NOT route through the AI Gateway. The gateway can't
  // carry a binary multipart body via the `env.AI.run` binding — it rejects a
  // ReadableStream and JSON-serializes an ArrayBuffer body to `{}` ("Invalid input").
  // Chat calls go through the gateway because their inputs are plain JSON.
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "512");
  form.append("height", "512");
  const formResponse = new Response(form);

  // The `Ai` binding overloads don't cover this model id, so cast at the call.
  const res = (await env.AI.run(
    AVATAR_IMAGE_MODEL_ID as Parameters<Ai["run"]>[0],
    {
      multipart: {
        body: formResponse.body,
        contentType: formResponse.headers.get("content-type")
      }
    } as Parameters<Ai["run"]>[1]
  )) as { image?: string };

  if (!res?.image) {
    throw new Error("image model returned no image data");
  }
  const binary = atob(res.image);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return { data, contentType: "image/jpeg" };
}
