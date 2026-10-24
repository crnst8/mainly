/** Synthetic provider compatibility check. Never reads mailbox data. */
process.env.DATABASE_URL ??= 'postgres://x/none';
process.env.SECRET_KEY ??= Buffer.alloc(32).toString('base64');
process.env.SESSION_SECRET ??= 'x';
// Use the production timeout unless explicitly overridden.
const llm = await import('../src/filter/llm.ts');
try { console.log('models:', (await llm.listModels()).join(' ')); } catch (e) { console.log('listModels failed:', e.message); }
const ex = (name, address, subject, verdict) => ({ from: { name, address }, subject, verdict });
const examples = [
  ex('Acme Store', 'offers@acme-store.example', 'Last chance: 30% off sitewide', 'filter'),
  ex('Weekly Digest', 'digest@newsletter.example', 'Your weekly roundup', 'filter'),
  ex('TravelCo', 'deals@travelco.example', 'Flights from $49 this weekend', 'filter'),
  ex('Jordan Park', 'jordan@park.example', 'Re: contract draft', 'keep'),
  ex('Bank', 'alerts@bank.example', 'Payment due in 3 days', 'keep'),
];
const m = (name, address, subject, preview, addressed, bulk, want) => ({ msg: { from: { name, address }, subject, preview, addressed, bulk }, want });
const cases = [
  m('Gadget Hub', 'promo@gadgethub.example', 'Flash sale: headphones 50% off', 'Ends tonight. Shop now.', 'hidden', true, true),
  m('Recipes Daily', 'news@recipes.example', 'Five dinners under 20 minutes', 'This week in the kitchen', 'hidden', true, true),
  m('Hotel Deals', 'offers@stays.example', 'Members save 25% on summer stays', 'Book by Friday', 'hidden', true, true),
  m('Fashion Co', 'hello@fashion.example', 'New arrivals you will love', 'The autumn collection is here', 'hidden', true, true),
  m('Alex Chen', 'alex@chen.example', 'Can we move Thursday?', 'Something came up, does 3pm work', 'direct', false, false),
  m('Your Bank', 'security@bank.example', 'New sign-in from Chrome on Windows', 'If this was not you, reset your password', 'direct', false, false),
  m('Courier', 'tracking@courier.example', 'Your parcel is out for delivery', 'Arriving today between 2 and 5pm', 'direct', true, false),
  m('Priya', 'priya@friend.example', 'Re: photos from the weekend', 'Here are the rest of them', 'direct', false, false),
  m('Electricity Co', 'billing@power.example', 'Your bill is ready: $142.10 due 14 Nov', 'View and pay your bill', 'direct', true, false),
  m('Weekly Digest', 'digest@newsletter.example', 'Your weekly roundup', 'Top stories this week', 'hidden', true, true),
];
for (const model of (process.argv.length > 2 ? process.argv.slice(2) : ['minimax-m3.1-flash'])) {
  const t = Date.now();
  try {
    const v = await llm.classify('benchmark-user', model, cases.map((c) => c.msg), examples);
    let right = 0, answered = 0, wrong = 0;
    v.forEach((x, i) => { if (!x) return; answered++; const f = x.filter && x.confidence >= 0.8; if (f === cases[i].want) right++; if (f && !cases[i].want) wrong++; });
    console.log(`${model.padEnd(28)} ${Date.now() - t}ms answered ${answered}/10 correct ${right}/10 wrongly-filed ${wrong}`);
  } catch (e) { console.log(`${model.padEnd(28)} ${Date.now() - t}ms ERROR ${e.message.slice(0, 120)}`); }
}
process.exit(0);