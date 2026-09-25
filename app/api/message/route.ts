// app/api/message/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { roomId, messageId, encryptedPayload, senderId, type } = body;

    if (!roomId || !messageId || !encryptedPayload) {
      return NextResponse.json({ error: 'Missing cryptographic payload' }, { status: 400 });
    }

    // Store the encrypted payload (text, audio, or image base64) with a 5-minute self-destruct
    await redis.set(
      `msg:${roomId}:${messageId}`, 
      JSON.stringify({ payload: encryptedPayload, sender: senderId, type: type || 'text' }), 
      { ex: 300 } 
    );

    await redis.sadd(`room:${roomId}:index`, messageId);
    await redis.expire(`room:${roomId}:index`, 600);

    return NextResponse.json({ success: true, messageId }, { status: 201 });
  } catch (error) {
    console.error('POST /api/message error:', error);
    return NextResponse.json({ error: 'Server failure' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get('roomId');
    if (!roomId) return NextResponse.json({ error: 'Missing Room ID' }, { status: 400 });

    const messageIds = await redis.smembers(`room:${roomId}:index`);
    const messages = [];

    for (const msgId of messageIds) {
      const data = await redis.get(`msg:${roomId}:${msgId}`);
      if (data) {
        let parsed = data;
        if (typeof data === 'string') {
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { payload: data };
          }
        }
        messages.push({ id: msgId, ...(parsed as object) });
      } else {
        await redis.srem(`room:${roomId}:index`, msgId);
      }
    }
    return NextResponse.json({ success: true, messages }, { status: 200 });
  } catch (error) {
    console.error('GET /api/message error:', error);
    return NextResponse.json({ error: 'Server failure' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get('roomId');
    const messageId = searchParams.get('messageId');

    if (!roomId || !messageId) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    await redis.del(`msg:${roomId}:${messageId}`);
    await redis.srem(`room:${roomId}:index`, messageId);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/message error:', error);
    return NextResponse.json({ error: 'Server failure' }, { status: 500 });
  }
}
