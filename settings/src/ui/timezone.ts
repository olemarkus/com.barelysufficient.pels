export const getTimeZoneOffsetMinutes = (date: Date, timeZone: string) => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
    }).formatToParts(date);
    const tzName = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    const match = tzName.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!match) return 0;
    const hours = Number(match[1]);
    const minutes = match[2] ? Number(match[2]) : 0;
    return hours * 60 + Math.sign(hours) * minutes;
  } catch {
    return 0;
  }
};

export const getZonedParts = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const map = parts.reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') {
      return { ...acc, [part.type]: part.value };
    }
    return acc;
  }, {});
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
};

export const getDateKeyInTimeZone = (date: Date, timeZone: string) => {
  const { year, month, day } = getZonedParts(date, timeZone);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
};

export const getDateKeyStartMs = (dateKey: string, timeZone: string) => {
  const [year, month, day] = dateKey.split('-').map((value) => Number(value));
  const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcMidnight), timeZone);
  return utcMidnight - offsetMinutes * 60 * 1000;
};

export const getStartOfDayInTimeZone = (date: Date, timeZone: string) => (
  getDateKeyStartMs(getDateKeyInTimeZone(date, timeZone), timeZone)
);

export const getWeekStartInTimeZone = (date: Date, timeZone: string) => {
  const { year, month, day } = getZonedParts(date, timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const diffToMonday = (weekday + 6) % 7;
  const weekStartDate = new Date(Date.UTC(year, month - 1, day - diffToMonday));
  return getStartOfDayInTimeZone(weekStartDate, timeZone);
};

export const getMonthStartInTimeZone = (date: Date, timeZone: string) => {
  const { year, month } = getZonedParts(date, timeZone);
  const monthStartDate = new Date(Date.UTC(year, month - 1, 1));
  return getStartOfDayInTimeZone(monthStartDate, timeZone);
};

export const formatDateInTimeZone = (date: Date, options: Intl.DateTimeFormatOptions, timeZone: string) => (
  date.toLocaleDateString([], { timeZone, ...options })
);

export const formatTimeInTimeZone = (date: Date, options: Intl.DateTimeFormatOptions, timeZone: string) => (
  date.toLocaleTimeString([], { timeZone, ...options })
);
