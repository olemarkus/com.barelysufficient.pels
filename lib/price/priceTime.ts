export const formatDateInTimeZone = (date: Date, timeZone: string): string => {
  try {
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(date);
  } catch {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
};

export const getHourStartInTimeZone = (date: Date, timeZone: string): number => {
  try {
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const getPart = (type: Intl.DateTimeFormatPartTypes) => {
      const part = parts.find((entry) => entry.type === type);
      return part ? part.value : '';
    };
    const year = Number(getPart('year'));
    const month = Number(getPart('month'));
    const day = Number(getPart('day'));
    const hour = Number(getPart('hour'));
    const minute = Number(getPart('minute'));
    const second = Number(getPart('second'));
    if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value))) {
      throw new Error('Invalid date parts');
    }
    const utcCandidate = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMs = utcCandidate - date.getTime();
    return Date.UTC(year, month - 1, day, hour, 0, 0, 0) - offsetMs;
  } catch {
    const fallback = new Date(date);
    fallback.setMinutes(0, 0, 0);
    return fallback.getTime();
  }
};
