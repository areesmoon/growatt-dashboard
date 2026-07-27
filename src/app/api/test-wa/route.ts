import { NextRequest, NextResponse } from 'next/server';
import wa from '@/lib/whatsapp';

export async function GET(request: NextRequest) {
    try {
        // 1. Keamanan CRON_SECRET
        const authHeader = request.headers.get('authorization');
        const urlParams = request.nextUrl.searchParams;
        const querySecret = urlParams.get('secret');
        const bearerToken = authHeader ? authHeader.replace('Bearer ', '') : null;
        const isAuthorized = (process.env.CRON_SECRET && (bearerToken === process.env.CRON_SECRET || querySecret === process.env.CRON_SECRET));

        if (process.env.CRON_SECRET && !isAuthorized) {
            return NextResponse.json({ error: 'Unauthorized: Secret key salah atau tidak ada.' }, { status: 401 });
        }

        // 2. Ambil parameter target nomor atau pesan opsional dari URL query
        // Contoh: /api/growatt/test-wa?secret=KODERAHASIA&message=Halo%20Dunia&phone=628123456789
        const targetPhone = urlParams.get('phone') || process.env.WA_TARGET_NUMBER || '';
        const customMessage = urlParams.get('message') || `🤖 *TEST NOTIFIKASI WA*\n\nHalo, sistem WhatsApp Gateway Growatt Rumah Kablukan berjalan normal dan terhubung sempurna!\n🕒 Waktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;

        if (!targetPhone) {
            return NextResponse.json(
                { success: false, error: 'Nomor tujuan (target_number) belum diset di .env.local atau parameter URL!' },
                { status: 400 }
            );
        }

        console.log(`📨 Mengirim pesan test WhatsApp ke target: ${targetPhone}`);

        // 3. Kirim pesan pakai service WhatsApp kita
        const result = await wa.sendMessage(targetPhone, customMessage);

        return NextResponse.json({
            success: true,
            message: 'Pesan test WhatsApp berhasil dikirim!',
            targetPhone,
            gatewayResponse: result
        });

    } catch (error: any) {
        console.error('❌ Gagal kirim test pesan WhatsApp:', error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}