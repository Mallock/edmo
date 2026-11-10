/** The carrier's hold — four partial views folded into one honest figure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CarrierHold, describeCarrierHold, parseCarrierStock } from '../src/engine/carrierhold.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent =>
  ({ timestamp: '2026-09-18T20:11:50Z', ...o }) as unknown as JournalEvent;

const CARRIER = 3712889600;

const stats = (cargo: number): JournalEvent =>
  ev({
    event: 'CarrierStats',
    CarrierID: CARRIER,
    Callsign: 'V6W-TTJ',
    SpaceUsage: { TotalCapacity: 25000, Crew: 6570, Cargo: cargo, CargoSpaceReserved: 0, FreeSpace: 25000 - 6570 - cargo },
  });

const owned = (): CarrierHold => {
  const h = new CarrierHold();
  h.apply(ev({ event: 'CarrierLocation', CarrierID: CARRIER, StarSystem: 'HIP 71120' }));
  return h;
};

test('no carrier means an empty, honest snapshot', () => {
  const h = new CarrierHold();
  const s = h.snapshot();
  assert.equal(s.items.length, 0);
  assert.equal(s.reportedTons, null);
  assert.equal(s.unaccountedTons, null);
  assert.equal(describeCarrierHold(s, 0, 17, 0), null);
});

test('transfers to the carrier build the ledger, both directions', () => {
  const h = owned();
  h.apply(
    ev({
      event: 'CargoTransfer',
      Transfers: [
        { Type: 'steel', Type_Localised: 'Steel', Count: 520, Direction: 'tocarrier' },
        { Type: 'titanium', Type_Localised: 'Titanium', Count: 264, Direction: 'tocarrier' },
      ],
    }),
  );
  assert.equal(h.tons().get('steel'), 520);
  assert.equal(h.tons().get('titanium'), 264);
  // Taking it back off again is the same event with the other direction.
  h.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'steel', Count: 200, Direction: 'toship' }] }));
  assert.equal(h.tons().get('steel'), 320);
});

test('a direction the game did not write is skipped, not guessed at', () => {
  const h = owned();
  h.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'steel', Count: 500, Direction: 'sideways' }] }));
  assert.equal(h.tons().size, 0);
});

test('the ledger never goes negative — a missed load is not a debt', () => {
  const h = owned();
  h.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'steel', Count: 40, Direction: 'toship' }] }));
  assert.equal(h.snapshot().items.length, 0);
  assert.equal(h.tons().get('steel'), undefined);
});

test('the carrier board is authoritative for what it lists — and silent about the rest', () => {
  const h = owned();
  h.apply(
    ev({
      event: 'CargoTransfer',
      Transfers: [
        { Type: 'steel', Count: 520, Direction: 'tocarrier' },
        { Type: 'liquidoxygen', Type_Localised: 'Liquid oxygen', Count: 90, Direction: 'tocarrier' },
      ],
    }),
  );
  // The board shows steel (it has an order against it) and says nothing about
  // the oxygen. The oxygen must survive: absence is not zero.
  h.readMarket(CARRIER, [{ name: 'Steel', stock: 4500 }], '2026-09-18T21:00:00Z');
  const s = h.snapshot();
  assert.equal(h.tons().get('steel'), 4500);
  assert.equal(h.tons().get('liquidoxygen'), 90);
  assert.equal(s.items.find((i) => i.key === 'steel')!.basis, 'market');
  assert.equal(s.items.find((i) => i.key === 'liquidoxygen')!.basis, 'ledger');
});

test("another station's market never touches the carrier's hold", () => {
  const h = owned();
  h.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'steel', Count: 100, Direction: 'tocarrier' }] }));
  assert.equal(h.readMarket(128666762, [{ name: 'Steel', stock: 9999 }], '2026-09-18T21:00:00Z'), false);
  assert.equal(h.tons().get('steel'), 100);
});

test('buying from your own carrier empties it; selling to it fills it', () => {
  const h = owned();
  h.apply(stats(1000));
  h.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'steel', Count: 1000, Direction: 'tocarrier' }] }));
  h.apply(ev({ event: 'MarketBuy', MarketID: CARRIER, Type: 'steel', Count: 400 }));
  assert.equal(h.tons().get('steel'), 600);
  h.apply(ev({ event: 'MarketSell', MarketID: CARRIER, Type: 'steel', Count: 150 }));
  assert.equal(h.tons().get('steel'), 750);
  // A bubble shopping run is not a carrier movement.
  h.apply(ev({ event: 'MarketBuy', MarketID: 128666762, Type: 'steel', Count: 700 }));
  assert.equal(h.tons().get('steel'), 750);
});

test('unaccounted tonnage is stated, not hidden', () => {
  const h = owned();
  h.apply(stats(5000));
  h.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'steel', Count: 800, Direction: 'tocarrier' }] }));
  const s = h.snapshot();
  assert.equal(s.namedTons, 800);
  assert.equal(s.reportedTons, 5000);
  assert.equal(s.unaccountedTons, 4200);
  assert.equal(s.fromBoard, false);
});

test('a ledger above what the game reports goes negative rather than quietly right', () => {
  const h = owned();
  h.apply(stats(100));
  h.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'steel', Count: 800, Direction: 'tocarrier' }] }));
  assert.equal(h.snapshot().unaccountedTons, -700);
});

test('a restored hold is a ledger reading again, never a board one', () => {
  const h = owned();
  h.readMarket(CARRIER, [{ name: 'Steel', stock: 4500 }], '2026-09-18T21:00:00Z');
  const saved = JSON.parse(JSON.stringify(h.toJSON()));
  const back = new CarrierHold();
  back.load(saved);
  assert.equal(back.tons().get('steel'), 4500);
  assert.equal(back.snapshot().items[0].basis, 'ledger');
  assert.equal(back.snapshot().callsign, null); // no CarrierStats was ever seen
});

test('a board reading keeps stock the trade parser would have thrown away', () => {
  // A commander can price their own carrier's stock at zero for squadmates.
  // The trade parser drops those rows (no trade in them); a hold reading must
  // not, or the warehouse the whole plan rests on under-reports itself.
  const parsed = parseCarrierStock(
    ev({
      event: 'Market',
      MarketID: CARRIER,
      Items: [
        { Name: '$steel_name;', Name_Localised: 'Steel', BuyPrice: 0, SellPrice: 0, Stock: 4500, Demand: 0 },
        { Name: '$titanium_name;', Name_Localised: 'Titanium', BuyPrice: 900, SellPrice: 0, Stock: 300, Demand: 0 },
        // Nothing aboard — a demand row is an order, not a ton.
        { Name: '$water_name;', Name_Localised: 'Water', BuyPrice: 0, SellPrice: 120, Stock: 0, Demand: 900 },
      ],
    }),
  )!;
  assert.deepEqual(parsed.items, [
    { name: 'Steel', stock: 4500 },
    { name: 'Titanium', stock: 300 },
  ]);
  const h = owned();
  h.readMarket(parsed.marketId, parsed.items, parsed.at);
  assert.equal(h.tons().get('steel'), 4500);
  assert.equal(h.tons().get('water'), undefined);
  // A board with nothing on it at all is not a reading.
  assert.equal(parseCarrierStock(ev({ event: 'Market', MarketID: CARRIER, Items: [] })), null);
});

test('the summary leads with coverage of the build, not tonnage aboard', () => {
  const h = owned();
  h.apply(stats(4512));
  h.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'steel', Count: 4512, Direction: 'tocarrier' }] }));
  h.apply(ev({ event: 'CarrierStats', CarrierID: CARRIER, Callsign: 'V6W-TTJ', SpaceUsage: { Cargo: 4512 } }));
  const line = describeCarrierHold(h.snapshot(), 6, 17, 4512)!;
  assert.match(line, /V6W-TTJ/);
  assert.match(line, /covers 6 of 17/);
  assert.match(line, /4,512 t/);
});

test('a carrier holding nothing the build wants says so plainly', () => {
  const h = owned();
  h.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'tritium', Count: 900, Direction: 'tocarrier' }] }));
  const line = describeCarrierHold(h.snapshot(), 0, 17, 0)!;
  assert.match(line, /none of it on this build's list/);
});
