/**
 * Skeleton 3-step copy: different angle each step, plain text, at most one
 * link (the booking link), no tracking anything. The real copy pack
 * (Phase 4, STOP-POINT H4) replaces the wording; the structure is fixed.
 */

export interface TemplateContext {
  contactName: string | null
  companyName: string
  city: string | null
  senderName: string
  bookingLink: string | null
}

interface RenderedEmail {
  subject: string
  body: string
}

function greeting(ctx: TemplateContext): string {
  return ctx.contactName ? `Hi ${ctx.contactName},` : 'Hi,'
}

function signoff(ctx: TemplateContext): string {
  const booking = ctx.bookingLink
    ? `\n\nIf it's easier, you can pick a time that suits you here: ${ctx.bookingLink}`
    : ''
  return `${booking}\n\nBest regards,\n${ctx.senderName}\nMaranasi`
}

/** step is 1-based. Each step takes a different angle — never a resend. */
export function renderStep(step: number, ctx: TemplateContext): RenderedEmail {
  const place = ctx.city ? ` in ${ctx.city}` : ''
  switch (step) {
    case 1:
      // Angle: direct introduction, one concrete reason for writing.
      return {
        subject: `Working with ${ctx.companyName}`,
        body: `${greeting(ctx)}

I came across ${ctx.companyName}${place} and wanted to reach out directly. We work with businesses like yours on sourcing and trade, and I think there's a concrete way we could be useful to you.

Would you be open to a short call to see if it's a fit?${signoff(ctx)}`,
      }
    case 2:
      // Angle: social proof / what working together looks like.
      return {
        subject: `How we work with businesses like ${ctx.companyName}`,
        body: `${greeting(ctx)}

Following up on my earlier note. In case it helps to picture it: we typically start small — one shipment or one project — so you can judge the working relationship on results rather than promises.

Happy to share specifics for a business like yours${place}. Would a 15-minute call this week work?${signoff(ctx)}`,
      }
    case 3:
      // Angle: polite close with an explicit door left open.
      return {
        subject: `Closing the loop — ${ctx.companyName}`,
        body: `${greeting(ctx)}

I don't want to clutter your inbox, so this is my last note for now. If expanding your sourcing options becomes relevant later, my door is open and I'd be glad to talk.

Wishing you and ${ctx.companyName} a strong season.${signoff(ctx)}`,
      }
    default:
      throw new Error(`no template for step ${step}`)
  }
}
