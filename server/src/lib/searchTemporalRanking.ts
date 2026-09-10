/** Fetch the nearest candidates on BOTH sides before applying the result limit. */
export async function findNearestDatedMatches<T extends { id: string; date: Date }>(
  find: (query: { direction: 'future' | 'past'; anchor: Date; take: number }) => Promise<T[]>,
  limit: number,
  anchor: Date = new Date()
): Promise<T[]> {
  const [future, past] = await Promise.all([
    find({ direction: 'future', anchor, take: limit }),
    find({ direction: 'past', anchor, take: limit }),
  ]);
  return [...future, ...past]
    .sort((a, b) => {
      const ad = +a.date - +anchor;
      const bd = +b.date - +anchor;
      return Math.abs(ad) - Math.abs(bd) || bd - ad || a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}
