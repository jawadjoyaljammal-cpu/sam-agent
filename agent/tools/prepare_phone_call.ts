import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

const phoneNumberSchema = z
  .string()
  .trim()
  .min(7)
  .max(30)
  .describe("The client's phone number, preferably including the country code.");

function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  const hasLeadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length < 7 || digits.length > 15) {
    throw new Error("The phone number must contain between 7 and 15 digits.");
  }

  // Haidar operates in Canada, so a 10-digit local number defaults to +1.
  if (!hasLeadingPlus && digits.length === 10) {
    return `+1${digits}`;
  }

  return hasLeadingPlus ? `+${digits}` : digits;
}

export default defineTool({
  description:
    "Prepare a click-to-call button for a specific client. Use this only when Haidar explicitly asks to call that person or number in the current message. This tool never places a call by itself.",
  inputSchema: z.object({
    clientName: z.string().trim().min(1).max(120),
    phoneNumber: phoneNumberSchema,
    purpose: z.string().trim().min(1).max(500),
  }),
  outputSchema: z.object({
    clientName: z.string(),
    displayNumber: z.string(),
    callUrl: z.string(),
    purpose: z.string(),
    requiresUserTap: z.literal(true),
  }),
  approval: always(),
  async execute({ clientName, phoneNumber, purpose }) {
    const normalizedNumber = normalizePhoneNumber(phoneNumber);

    return {
      clientName,
      displayNumber: normalizedNumber,
      callUrl: `tel:${normalizedNumber}`,
      purpose,
      requiresUserTap: true as const,
    };
  },
});
