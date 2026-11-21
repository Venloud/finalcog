const dayMs = 24 * 60 * 60 * 1000;

function partsAt(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

export function localDateTimeToUtc(dateKey, time, timeZone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const localParts = partsAt(targetUtc, timeZone);
  const representedUtc = Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day,
    localParts.hour,
    localParts.minute,
    localParts.second,
  );
  const offset = representedUtc - targetUtc;
  let result = targetUtc - offset;

  // Recheck after the offset adjustment; this covers ordinary DST boundaries
  // without adding a timezone dependency.
  const verified = partsAt(result, timeZone);
  if (verified.year !== year || verified.month !== month || verified.day !== day ||
      verified.hour !== hour || verified.minute !== minute) {
    result += 60 * 60 * 1000;
  }
  return result;
}

export function generateSlots(settings, startTimestamp, count, existingTimes = []) {
  const timeZone = settings.timezone || 'UTC';
  const times = settings.preferredTimes?.length ? settings.preferredTimes : ['10:00'];
  const activeDays = new Set((settings.activeDays || []).map(Number));
  const postsPerWeek = Math.min(
    Math.max(1, Number(settings.postsPerWeek) || 1),
    Math.max(1, activeDays.size),
  );
  const activeDayList = [...activeDays].sort((a, b) => a - b);
  const dayIndexes = [];
  for (let index = 0; index < postsPerWeek; index += 1) {
    const selected = Math.floor(((index + 0.5) * activeDayList.length) / postsPerWeek);
    dayIndexes.push(activeDayList[selected]);
  }

  const now = startTimestamp;
  const localNow = partsAt(now, timeZone);
  const localToday = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day));
  const assigned = [...existingTimes].filter(Number.isFinite);
  const slots = [];
  const spacingMs = Math.max(3, Number(settings.minSpacingHours) || 3) * 60 * 60 * 1000;
  let slotIndex = 0;

  for (let dayOffset = 0; dayOffset < 370 && slots.length < count; dayOffset += 1) {
    const localDate = new Date(localToday.getTime() + dayOffset * dayMs);
    const weekday = localDate.getUTCDay();
    if (!dayIndexes.includes(weekday)) continue;
    const dateKey = [
      localDate.getUTCFullYear(),
      String(localDate.getUTCMonth() + 1).padStart(2, '0'),
      String(localDate.getUTCDate()).padStart(2, '0'),
    ].join('-');
    const time = times[slotIndex % times.length];
    slotIndex += 1;
    const candidate = localDateTimeToUtc(dateKey, time, timeZone);
    if (candidate <= now) continue;
    if (assigned.some(existing => Math.abs(existing - candidate) < spacingMs)) continue;
    assigned.push(candidate);
    slots.push(candidate);
  }
  return slots;
}

export function validateSettings(input, minimumSpacingHours = 3) {
  const timezone = String(input.timezone || 'UTC');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { throw new Error('Choose a valid timezone.'); }

  const postsPerWeek = Number(input.postsPerWeek);
  if (!Number.isInteger(postsPerWeek) || postsPerWeek < 1 || postsPerWeek > 21) {
    throw new Error('Videos per week must be between 1 and 21.');
  }

  const activeDays = [...new Set((input.activeDays || []).map(Number))].sort((a, b) => a - b);
  if (!activeDays.length || activeDays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('Choose at least one active day.');
  }
  if (postsPerWeek > activeDays.length) {
    throw new Error('Choose at least as many active days as videos per week.');
  }

  const preferredTimes = [...new Set((input.preferredTimes || []).map(String))];
  if (!preferredTimes.length || preferredTimes.length > 8 ||
      preferredTimes.some(value => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
    throw new Error('Add between one and eight valid posting times.');
  }

  const minSpacingHours = Number(input.minSpacingHours);
  if (!Number.isFinite(minSpacingHours) || minSpacingHours < minimumSpacingHours || minSpacingHours > 168) {
    throw new Error(`Minimum spacing must be between ${minimumSpacingHours} and 168 hours.`);
  }

  return { timezone, postsPerWeek, activeDays, preferredTimes, minSpacingHours };
}
