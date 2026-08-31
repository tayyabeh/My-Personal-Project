/**
 * Book-summary podcasts.
 *
 * Two ways in:
 *   1. Tayyab names a book  -> summarise that one.
 *   2. He just asks for a podcast -> ask what is on his mind and where he
 *      feels weak, then pick a book that fits the answer.
 *
 * The recommendation is for a 21-year-old, so it leans towards books that
 * are actually readable at that stage rather than a canon list nobody
 * finishes.
 *
 * On copyright: these are summaries of ideas in the assistant's own
 * words. The prompts forbid reproducing passages or inventing quotes, and
 * forbid recommending a book the model is not confident actually exists.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';
import { llm } from '../llm';
import { ROMAN_URDU, ROMAN_URDU_SPOKEN } from '../lang';

const BookSchema = z.object({
  title: z.string().min(2).max(120),
  author: z.string().min(2).max(80),
  why: z.string().min(10).max(400),
});

export type BookPick = z.infer<typeof BookSchema>;

/** Pick a book that fits what he just said about himself. */
export async function recommendBook(reflection: string): Promise<BookPick | null> {
  const result = await completeJson(
    BookSchema,
    [
      {
        role: 'system',
        content:
          'Tum ek 21 saal ke Pakistani larke ke liye ek kitab chunte ho, us baat ki bunyaad pe ' +
          'jo usne abhi apne baare mein batayi hai.\n\n' +
          'Sirf JSON do: {"title":"...","author":"...","why":"..."}\n\n' +
          'Rules:\n' +
          '- Sirf aisi kitab jo waqai maujood hai aur mashhoor hai. Kitab ya musannif ka naam ' +
          'mat banao. Agar yaqeen na ho to koi bohot mashhoor kitab chuno.\n' +
          '- Aisi kitab jo 21 saal ka banda waqai parh le — bhaari academic kitab nahi.\n' +
          '- title aur author English mein (asli naam).\n' +
          `- "why" Roman Urdu mein, 2 jumle: yeh kitab uski batayi hui baat se kaise juri hai.\n\n` +
          ROMAN_URDU,
      },
      {
        role: 'user',
        content: 'Main har kaam kal pe daal deta hoon, focus nahi hota, phone pe waqt zaya karta hoon',
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          title: 'Atomic Habits',
          author: 'James Clear',
          why: 'Tum keh rahe ho kaam kal pe chala jata hai aur focus nahi banta. Yeh kitab bilkul isi cheez pe hai — chhoti aadaton se system banana, motivation ka intezaar kiye baghair.',
        }),
      },
      { role: 'user', content: reflection },
    ],
    { temperature: 0.6, maxTokens: 600 },
  );

  return result.ok ? result.data : null;
}

/**
 * The spoken script.
 *
 * Grounded in his own words where possible, because a summary that never
 * connects back to why he asked is just a book report.
 */
export async function bookScript(
  book: { title: string; author: string },
  reflection: string,
  situation: string,
): Promise<string> {
  return llm().complete(
    [
      {
        role: 'system',
        content:
          `Tum "${book.title}" (${book.author}) ka summary bol kar suna rahe ho, ek 21 saal ke ` +
          'dost ko. Lagbhag 180 lafz — 90 second.\n\n' +
          'Structure:\n' +
          '1. Kitab ka asal khayal ek jumle mein.\n' +
          '2. Do ya teen sab se kaam ke ideas, apne lafzon mein samjhao.\n' +
          '3. Aakhir mein ek concrete cheez jo woh is hafte kar sakta hai.\n\n' +
          'Rules:\n' +
          '- Kitab se koi jumla hu-ba-hu mat parho aur koi quote mat banao. Sab kuch apne ' +
          'lafzon mein.\n' +
          '- Jo usne apne baare mein bataya hai, us se kam az kam ek dafa jodo.\n' +
          '- Agar us kitab ke baare mein yaqeen se kuch nahi pata, to jhoot mat bolo — jo ' +
          'pakka pata hai wahi kaho.\n' +
          '- Hype coach mat bano. Seedhi, dostana baat.\n\n' +
          ROMAN_URDU_SPOKEN,
      },
      {
        role: 'user',
        content:
          `Usne apne baare mein yeh kaha: "${reflection}"\n\n` +
          `Uski asli surat-e-haal: ${situation}`,
      },
    ],
    { temperature: 0.75, maxTokens: 900 },
  );
}

/** Pull a book title out of "X ka podcast bana do", if one was named. */
export async function bookFromRequest(text: string): Promise<BookPick | null> {
  const NamedSchema = z.object({
    named: z.boolean(),
    title: z.string().max(120).default(''),
    author: z.string().max(80).default(''),
  });

  const result = await completeJson(
    NamedSchema,
    [
      {
        role: 'system',
        content:
          'Kya is message mein koi kitab ka naam liya gaya hai?\n\n' +
          'Sirf JSON: {"named":true|false,"title":"...","author":"..."}\n' +
          'Agar kitab ka naam hai to named=true aur title do (author agar pata ho, warna khali). ' +
          'Agar sirf podcast maanga hai bina kitab ke naam ke, to named=false.',
      },
      { role: 'user', content: 'Atomic Habits ka podcast bana do' },
      {
        role: 'assistant',
        content: JSON.stringify({ named: true, title: 'Atomic Habits', author: 'James Clear' }),
      },
      { role: 'user', content: 'mujhe podcast chahiye' },
      { role: 'assistant', content: JSON.stringify({ named: false, title: '', author: '' }) },
      { role: 'user', content: text },
    ],
    { temperature: 0, maxTokens: 300 },
  );

  if (!result.ok || !result.data.named || !result.data.title) return null;

  return {
    title: result.data.title,
    author: result.data.author || 'unknown',
    why: '',
  };
}
