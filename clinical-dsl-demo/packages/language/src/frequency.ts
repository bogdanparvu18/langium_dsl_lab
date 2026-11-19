const frequencyCodes = new Set(['QD', 'BID', 'TID', 'QID', 'PRN']);

/** Convert a frequency field to the schedule carried by the AST and Scala bridge. */
export function normalizeFrequency(input: string): string | undefined {
    const value = input.trim().toUpperCase();
    if (frequencyCodes.has(value)) return value;
    const interval = /^(?:Q\s*)?([1-9]\d*)(?:\s*[-–]\s*([1-9]\d*))?\s*H(?:\s+(PRN))?$/.exec(value);
    if (!interval) return undefined;
    const [, start, end, asNeeded] = interval;
    // Digits have no leading zeroes, so comparison works without rounding.
    if (end && (end.length < start.length || end.length === start.length && end <= start)) return undefined;
    return `Q${start}${end ? `-${end}` : ''}H${asNeeded ? ' PRN' : ''}`;
}

/** Render the editable, unquoted frequency in a Medication declaration. */
export function formatFrequency(input: string): string | undefined {
    return normalizeFrequency(input)?.replace(/^Q(?=\d)/, '');
}
