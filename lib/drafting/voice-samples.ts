// Placeholder voice samples — REPLACE with Kev's real cold emails before
// the gate review. The drafter quotes these in the system prompt as the
// only correct register; bad samples here = bad output.
//
// Format: subject is lowercase, six words max. Body is under 90 words,
// no greeting boilerplate, ends with "Kev".

export type VoiceSample = {
  subject: string;
  body: string;
};

export const VOICE_SAMPLES: VoiceSample[] = [
  {
    subject: "noticed the 3 resourcer roles",
    body: `Hi {firstName}, saw you're hiring 3 resourcers this quarter. Usually that's the tell that consultants are drowning in sourcing instead of closing. We build custom AI agents that handle the LinkedIn digging and CV first-pass so your team focuses on the placement side. Worth a quick reply if that sounds relevant?

Kev`,
  },
  {
    subject: "quick one on your reporting ops",
    body: `Hi {firstName}, read your post about scaling to 15 — congrats. Most agencies that size start hitting the wall on client reporting. We've built automation for a few similar teams that cut the weekly reporting work from a day to an hour. Open to a 15-min look?

Kev`,
  },
  {
    subject: "the bullhorn export problem",
    body: `Hi {firstName}, most Bullhorn shops I talk to say the same thing — the data's there, pulling anything useful out of it is the nightmare. We've built custom dashboards + auto-reporting that sit on top of Bullhorn and generate what your consultants actually need. Relevant?

Kev`,
  },
];

// Phrases the drafter must not produce. Easier to enforce as a regex
// list than to argue with the model in the system prompt.
export const FORBIDDEN_PHRASES: RegExp[] = [
  /\bi hope (this|you|this email)\b/i,
  /\btouching base\b/i,
  /\bcircling back\b/i,
  /\bsynerg(y|ies|ize)\b/i,
  /\brevolutioniz(e|ing|ation)\b/i,
  /\bgame[ -]chang(er|ing)\b/i,
  /\bquick 15[ -]min(?:utes?)? on (?:tuesday|wednesday|monday|thursday|friday)\b/i,
  /\bleverage\b/i,
  /\bunlock\b/i,
  /\bempower\b/i,
];

export function findForbiddenPhrases(text: string): string[] {
  const hits: string[] = [];
  for (const re of FORBIDDEN_PHRASES) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
