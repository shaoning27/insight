import { NextResponse } from 'next/server';
import { AI_BOT_REGEX } from '@/lib/bots';
export const dynamic = 'force-dynamic';
export async function GET() {
  return NextResponse.json({ regex: AI_BOT_REGEX }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
