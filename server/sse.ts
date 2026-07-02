import type { Response } from "express";

export function writeSseEvent(
  res: Response,
  event: string,
  data: unknown
): void {
  const jsonData = JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${jsonData}\n\n`);
}
