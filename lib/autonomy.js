/**
 * settings.autonomy — 「主动一点」.
 *   enabled          prompt gets the proactive paragraph (else the passive one) and the pet's local rules
 *                    (runtime/pixelpet/autonomy.py) run. Local rules do not use the AI, so they follow this
 *                    switch only, not aiControl. Session status mirrors (working / failed …) ignore it.
 *   rules            one switch per local rule, all on by default
 *   quietHours       'HH:MM' pair, '' = off; inside the window the pet only sleeps
 *   aware            「允许感知在做什么」: privacy switch for activity awareness (lib/awareness.js)
 *   care             「主动关心」: wake + judge (lib/proactive.js), default off; needs aware + aiControl + a bound session
 *   careLevel        少 / 适中 / 多 → wake gap and daily speak cap (lib/proactive.js LEVELS)
 *   speakUp          reserved for "AI 主动开口"; always false for now, no behavior
 *   proactivePrompt / passivePrompt   '' = prompts/proactive.md / passive.md
 */
import { DEFAULT_PASSIVE, DEFAULT_PROACTIVE, sanitizePart } from './prompt.js'

export const AUTONOMY_RULES = ['idleSleep', 'welcomeBack', 'breakReminder', 'lateNight', 'morningHello', 'newMail', 'fullscreenHide', 'idleFidget', 'gameCalm', 'videoCompany', 'meetingQuiet', 'videoCorner']
export const CARE_LEVELS = ['little', 'medium', 'much']
export const DEFAULT_AUTONOMY = Object.freeze({
  enabled: true,
  aware: false, // 「允许感知在做什么」: privacy switch, off by default (lib/awareness.js, runtime activity.py)
  care: false,  // 「主动关心」: wake + AI judges (lib/proactive.js), off by default
  careLevel: 'medium', // 少 / 适中 / 多
  rules: Object.freeze(Object.fromEntries(AUTONOMY_RULES.map((k) => [k, true]))),
  quietHours: Object.freeze({ start: '', end: '' }),
  speakUp: false,
  proactivePrompt: '',
  passivePrompt: '',
})

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const time = (v, keep) => (typeof v === 'string' && (v === '' || HHMM.test(v)) ? v : keep)

export function sanitizeAutonomy (cur, patch) {
  const c = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const pick = (k) => (k in p ? p[k] : c[k])
  const bool = (v, d) => (typeof v === 'boolean' ? v : d)
  const level = pick('careLevel')
  const out = {
    enabled: bool(p.enabled, bool(c.enabled, true)),
    aware: bool(p.aware, bool(c.aware, false)),
    care: bool(p.care, bool(c.care, false)),
    careLevel: CARE_LEVELS.includes(level) ? level : (CARE_LEVELS.includes(c.careLevel) ? c.careLevel : 'medium'),
    rules: {},
    quietHours: { start: '', end: '' },
    speakUp: false, // reserved: no UI and no behavior yet
    proactivePrompt: '',
    passivePrompt: '',
  }
  const cr = c.rules && typeof c.rules === 'object' ? c.rules : {}
  const pr = p.rules && typeof p.rules === 'object' ? p.rules : {}
  for (const k of AUTONOMY_RULES) out.rules[k] = bool(pr[k], bool(cr[k], true))
  const cq = c.quietHours && typeof c.quietHours === 'object' ? c.quietHours : {}
  const pq = p.quietHours && typeof p.quietHours === 'object' ? p.quietHours : {}
  out.quietHours.start = time(pq.start, time(cq.start, ''))
  out.quietHours.end = time(pq.end, time(cq.end, ''))
  // a half-filled pair is kept (the page is mid-edit) but only a full, non-empty window is in effect
  if (out.quietHours.start && out.quietHours.start === out.quietHours.end) out.quietHours = { start: '', end: '' }
  out.proactivePrompt = sanitizePart(pick('proactivePrompt'), DEFAULT_PROACTIVE)
  out.passivePrompt = sanitizePart(pick('passivePrompt'), DEFAULT_PASSIVE)
  return out
}
