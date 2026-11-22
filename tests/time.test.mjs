import {
  formatCalendarDate,
  formatDateTime,
  formatOffset,
  parseWallClock,
  tickLabel,
  toWallClockValue,
  tzOffsetSec,
  tzParts,
  tzWallToUtc
} from '../public/js/time.mjs';
import { test, assert, assertEqual } from './harness.mjs';

const NY = 'America/New_York';
const CHI = 'America/Chicago';

test('standard time: same instant in UTC, New York and Chicago', () => {
  const ts = Date.UTC(2020, 0, 15, 12, 0) / 1000;
  assertEqual(tzOffsetSec(ts, NY), -5 * 3600, 'NY offset');
  assertEqual(tzOffsetSec(ts, CHI), -6 * 3600, 'Chicago offset');
  assertEqual(formatDateTime(ts, 'UTC'), '2020-01-15 12:00', 'UTC wall clock');
  assertEqual(formatDateTime(ts, NY), '2020-01-15 07:00', 'NY wall clock');
  assertEqual(formatDateTime(ts, CHI), '2020-01-15 06:00', 'Chicago wall clock');
  // the instant itself is untouched by any conversion
  assertEqual(ts, 1579089600, 'UTC seconds');
});

test('daylight time: offsets follow IANA rules', () => {
  const ts = Date.UTC(2020, 6, 15, 12, 0) / 1000;
  assertEqual(tzOffsetSec(ts, NY), -4 * 3600, 'NY offset');
  assertEqual(tzOffsetSec(ts, CHI), -5 * 3600, 'Chicago offset');
  assertEqual(formatDateTime(ts, NY), '2020-07-15 08:00', 'NY wall clock');
  assertEqual(formatDateTime(ts, CHI), '2020-07-15 07:00', 'Chicago wall clock');
});

test('DST transitions happen at the correct UTC instant', () => {
  const before = Date.UTC(2020, 2, 8, 6, 59) / 1000;
  const after = Date.UTC(2020, 2, 8, 7, 0) / 1000;
  assertEqual(tzOffsetSec(before, NY), -5 * 3600, 'NY before spring forward');
  assertEqual(tzOffsetSec(after, NY), -4 * 3600, 'NY after spring forward');
  // Chicago is one hour behind the East Coast, so its switch is at 08:00 UTC
  assertEqual(tzOffsetSec(Date.UTC(2020, 2, 8, 7, 59) / 1000, CHI), -6 * 3600, 'Chicago before spring forward');
  assertEqual(tzOffsetSec(Date.UTC(2020, 2, 8, 8, 0) / 1000, CHI), -5 * 3600, 'Chicago after spring forward');

  const fallBefore = Date.UTC(2020, 10, 1, 5, 59) / 1000;
  const fallAfter = Date.UTC(2020, 10, 1, 6, 0) / 1000;
  assertEqual(tzOffsetSec(fallBefore, NY), -4 * 3600, 'NY before fall back');
  assertEqual(tzOffsetSec(fallAfter, NY), -5 * 3600, 'NY after fall back');
});

test('wall clock parsing and formatting round-trip', () => {
  const samples = [
    Date.UTC(2020, 0, 2, 14, 30) / 1000,
    Date.UTC(2020, 6, 15, 13, 30) / 1000,
    Date.UTC(2019, 11, 31, 23, 0) / 1000,
    Date.UTC(2026, 9, 28, 19, 59) / 1000
  ];
  for (const ts of samples) {
    for (const zone of ['UTC', NY, CHI]) {
      const wall = toWallClockValue(ts, zone);
      const back = parseWallClock(wall, zone);
      assertEqual(back, ts, `${wall} in ${zone}`);
    }
  }
  assertEqual(parseWallClock('2020-07-15T09:30', NY), Date.UTC(2020, 6, 15, 13, 30) / 1000, 'NY 09:30 summer');
  assertEqual(parseWallClock('2020-01-15T09:30', NY), Date.UTC(2020, 0, 15, 14, 30) / 1000, 'NY 09:30 winter');
  assertEqual(parseWallClock('2020-07-15T17:00', CHI), Date.UTC(2020, 6, 15, 22, 0) / 1000, 'Chicago 17:00 summer');
});

test('changing the display zone only changes labels', () => {
  const ts = Date.UTC(2020, 6, 15, 13, 30) / 1000;
  const ny = parseWallClock(formatDateTime(ts, NY).replace(' ', 'T'), NY);
  const chi = parseWallClock(formatDateTime(ts, CHI).replace(' ', 'T'), CHI);
  const utc = parseWallClock(formatDateTime(ts, 'UTC').replace(' ', 'T'), 'UTC');
  assertEqual(ny, ts, 'NY label re-parses to the same instant');
  assertEqual(chi, ts, 'Chicago label re-parses to the same instant');
  assertEqual(utc, ts, 'UTC label re-parses to the same instant');
  assertEqual(formatDateTime(ts, NY).slice(11), '09:30', 'NY label');
  assertEqual(formatDateTime(ts, CHI).slice(11), '08:30', 'Chicago label');
});

test('offset labels and daily-bar calendar dates', () => {
  const summer = Date.UTC(2020, 6, 15, 12, 0) / 1000;
  const winter = Date.UTC(2020, 0, 15, 12, 0) / 1000;
  assertEqual(formatOffset(tzParts(summer, NY).offset), 'UTC-04:00', 'NY summer offset label');
  assertEqual(formatOffset(tzParts(winter, NY).offset), 'UTC-05:00', 'NY winter offset label');
  assertEqual(formatOffset(0), 'UTC', 'UTC label');
  // daily candles are stamped at UTC midnight of the trading date and must not
  // shift with the display zone
  const dailyStamp = Date.UTC(2020, 5, 15) / 1000;
  assertEqual(tickLabel(dailyStamp, 2, NY, 86400), '15 Jun', 'daily tick label');
  assertEqual(formatCalendarDate(dailyStamp), '2020-06-15', 'daily calendar date');
  assertEqual(tzWallToUtc(2020, 6, 15, 12, 0, 0, 'UTC'), dailyStamp + 12 * 3600, 'UTC passthrough');
  assertEqual(tickLabel(Date.UTC(2020, 6, 15, 13, 30) / 1000, 3, NY, 60), '09:30', 'intraday tick label uses the zone');
});
