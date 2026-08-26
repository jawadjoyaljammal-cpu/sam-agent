import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

function normalizeWhatsAppNumber(value: string): string {
  const digits = value.replace(/\D/g, "");

  if (digits.length < 7 || digits.length > 15) {
    throw new Error("The phone number must contain between 7 and 15 digits.");
  }

  // Haidar operates in Canada, so a 10-digit local number defaults to country code 1.
  return digits.length === 10 ? `1${digits}` : digits;
}

export default defineTool({
  description:
    "Prepare a button that opens a specific client's WhatsApp chat. Use only when Haidar explicitly asks to contact or call that person through WhatsApp in the current message. The tool cannot start a WhatsApp voice call; Haidar must tap the call icon in WhatsApp.",
  inputSchema: z.object({
    clientName: z.string().trim().min(1).max(120),
    phoneNumber: z.string().trim().min(7).max(30),
    purpose: z.string().trim().min(1).max(500),
  }),
  outputSchema: z.object({
    clientName: z.string(),
    displayNumber: z.string(),
    purpose: z.string(),
    requiresUserTap: z.literal(true),
    whatsappUrl: z.string(),
  }),
  approval: always(),
  async execute({ clientName, phoneNumber, purpose }) {
    const normalizedNumber = normalizeWhatsAppNumber(phoneNumber);

    return {
      clientName,
      displayNumber: `+${normalizedNumber}`,
      purpose,
      requiresUserTap: true as const,
      whatsappUrl: `https://wa.me/${normalizedNumber}`,
    };
  },
});
