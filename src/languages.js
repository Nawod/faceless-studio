// The director's visual languages (same names as engines/kit/PLAYBOOK.md §2), with their reference sheets.
// The dashboard lists them; channel.json → direction.languages turns each on/off for the automatic rotation.
import { channel } from './config.js';
import { kvGet } from './db.js';

export const LANGUAGES = [
  { id: 'object-mascot', name: 'Object mascot', refs: ['01-carrot-dance', '02-watermelon-stroll'], blurb: 'A food, object or organ with big eyes and stick limbs dances and reacts on a flat pastel field.', bestFor: 'body, food and everyday-object facts' },
  { id: 'modern-flat-people', name: 'Modern flat people', refs: ['03-noodle-walk', '04-ostrich-keys'], blurb: 'Noodle-limbed people and animals in clothes, no outlines, swagger walks in 3/4 view.', bestFor: 'human behaviour, psychology, history people' },
  { id: 'kinetic-type', name: 'Character + kinetic type', refs: ['05-fruit-type-stack', '14-rocket-moon-type'], blurb: 'Characters juggle, stack and catch physical letters; words become props.', bestFor: 'words, names, numbers, one big concept' },
  { id: 'storybook-process', name: 'Storybook process montage', refs: ['06-storybook-process', '13-plant-process'], blurb: 'A rounded flat landscape where the camera travels and each step transforms into the next.', bestFor: 'how things are made, grow or form' },
  { id: 'parallax-nature', name: 'Layered parallax nature', refs: ['07-frog-parallax-jump'], blurb: 'Dark foreground silhouettes frame an animal acting in a deep layered habitat.', bestFor: 'animals, habitats, survival tricks' },
  { id: 'pop-art', name: 'Pop-art graphic', refs: ['10-popart-swing', '08-tank-colorcut'], blurb: 'A tiny hero in vast colour fields that cut every shot; halftone bursts and speed dashes.', bestFor: 'speed, power, records, action' },
  { id: 'cinematic-flat', name: 'Cinematic camera flat', refs: ['09-boy-bike-camera'], blurb: 'One character shot like a film: tracking, over-the-shoulder and close-up reactions.', bestFor: 'stories with a protagonist, experiments' },
  { id: 'synthwave', name: 'Retro neon / synthwave', refs: ['11-synthwave-ride'], blurb: 'Symmetry, a giant sun disc, skyline silhouettes and reflections in violet and pink.', bestFor: 'space, future, technology, light' },
  { id: 'iris-worlds', name: 'Iris vignette worlds', refs: ['12-iris-world'], blurb: 'Small worlds build themselves inside circles that open, multiply and connect.', bestFor: '"imagine…", comparisons, cause and effect' },
  { id: 'line-drawn-world', name: 'Character + line-drawn world', refs: ['15-line-build-ikea'], blurb: 'A saturated field with the world in thin lines; one filled character, and props draw themselves.', bestFor: 'inventions, how things work' },
  { id: 'paper-cutout', name: 'Paper-cutout diorama', refs: [], blurb: 'Layered paper planes with soft shadows and stepped 12 fps motion.', bestFor: 'history, places, folk stories' },
  { id: 'generative-nature', name: 'Generative nature (p5)', refs: [], blurb: 'Particles, flow fields, waves, light and swarms driven by noise.', bestFor: 'weather, fluids, sound, micro-worlds' },
];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const byId = id => LANGUAGES.find(l => l.id === id);
/** Match a free-text name the director wrote ("Character + line-drawn world") to a language. */
export const byName = name => LANGUAGES.find(l => norm(name).startsWith(norm(l.name)) || norm(l.name).startsWith(norm(name)));

export function enabledLanguages(cfg = channel()) {
  const on = cfg.direction?.languages || {};
  return LANGUAGES.filter(l => on[l.id] !== false);
}

/** Languages the director may choose from for the next automatic film: enabled, minus the last few used. */
export function rotationChoices(cfg = channel()) {
  const enabled = enabledLanguages(cfg);
  const recent = new Set((kvGet('recentLanguages') || []).slice(-4).map(n => byName(n)?.id).filter(Boolean));
  const fresh = enabled.filter(l => !recent.has(l.id));
  return { choices: fresh.length ? fresh : enabled, recent: [...recent].map(id => byId(id).name) };
}
