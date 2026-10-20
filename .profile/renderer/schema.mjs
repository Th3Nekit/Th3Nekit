const string = { type: 'string', maxLength: 2000 };
const bool = { type: 'boolean' };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const literal = x => ({ const: x });
const list = items => ({ type: 'array', items });
const enumeration = values => ({ enum: values });
const object = (properties, optional = []) => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const scheme = enumeration(['tonalSpot', 'vibrant', 'expressive', 'fidelity', 'monochrome']);
const shape = enumeration(['cookie', 'cookie12', 'clover', 'sunny', 'flower', 'pill', 'soft', 'gem']);
const block = enumeration(['hero', 'about', 'stack', 'projects', 'stats', 'streak', 'socials', 'wave', 'buttons']);
const item = object({ icon: string, label: string });
const override = object({ text: string, icon: string, shape }, ['text', 'icon', 'shape']);
const labels = names => Object.fromEntries(names.split(' ').map(k => [k, string]));
const repo = object({ name: string, url: string, text: string, fork: bool, stars: integer, language: { type: ['string', 'null'] }, topics: list(string), visibility: literal('PUBLIC') });
const definitions = {
  'profile': object({ version: literal(1), login: string, seed: color, seedFromAvatar: literal(false), scheme, motion: bool, iconFill: bool,
    order: list(block), hidden: list(block),
    hero: object({ greeting: string, name: string, subtitle: string, typing: bool, avatarShape: shape, chips: list(item) }),
    about: object({ title: string, items: list(item) }), stack: object({ title: string, groups: list(object({ title: string, items: list(item) })) }),
    projects: object({ source: enumeration(['pinned', 'manual']), repos: list(string), overrides: { type: 'object', additionalProperties: override }, empty: string, fork: string }),
    stats: object({ ...labels('title stars contributions repos followers calendar weekdays languages'), showLanguages: bool }),
    streak: object(labels('title current longest days')),
    socials: object({ items: list(object({ icon: string, url: string })), variant: enumeration(['icon', 'chip']), fill: enumeration(['tonal', 'filled', 'outlined', 'brand']), shape, card: bool }, ['shape', 'card']),
    buttons: object({ items: list(object({ icon: string, label: string, url: string, style: enumeration(['filled', 'tonal']) })), card: bool }, ['card']),
  }, ['iconFill']),
  'public-data': object({ version: literal(1), login: string, capturedAt: { type: 'string', format: 'date-time' }, publicOnly: literal(true), statsPublicOnly: literal(true), example: bool,
    source: { type: ['object', 'string'] },
    data: object({ followers: integer, languages: list({ type: 'array', prefixItems: [string, integer], minItems: 2, maxItems: 2 }), pins: list(repo), all: list(repo),
      stars: integer, repos: integer, contributions: integer, days: { type: 'array' }, streak: object({ current: integer, longest: integer }) }, ['stars', 'repos', 'contributions', 'days', 'streak'])
  }, ['example', 'source']),
  'projects': object({ version: literal(1), projects: list(object({ name: string, seed: color, scheme, icon: string, shape, title: string, subtitle: string }, ['scheme', 'icon', 'shape', 'title', 'subtitle'])) }),
};
export const schemas = Object.fromEntries(Object.entries(definitions).map(([name, schema]) => [name, { $schema: 'https://json-schema.org/draft/2020-12/schema', title: `Expressive Profile offline ${name}`, ...schema }]));
export function checkSchema(value, schema, at = 'input') {
  if (schema.const !== undefined && value !== schema.const) throw Error(`Invalid ${at}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) throw Error(`Invalid ${at}: unsupported value`);
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.includes(type)) throw Error(`Invalid ${at}: expected ${types.join('/')}`);
  if (type === 'string' && ((schema.maxLength && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) throw Error(`Invalid ${at}: string constraint`);
  if (type === 'integer' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw Error(`Invalid ${at}: number range`);
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw Error(`Invalid ${at}: array length`);
    value.forEach((item, n) => { const sub = schema.prefixItems?.[n] ?? schema.items; if (sub) checkSchema(item, sub, `${at}[${n}]`); });
  }
  if (type === 'object') {
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) throw Error(`Missing ${at}.${name}`);
    for (const [key, item] of Object.entries(value)) {
      const sub = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : schema.additionalProperties;
      if (sub === false) throw Error(`Unknown ${at}.${key}`);
      if (sub && sub !== true) checkSchema(item, sub, `${at}.${key}`);
    }
  }
}
