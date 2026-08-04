import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// 1. Inisialisasi koneksi ke Firestore aman dari multiple instances
if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not found");

    const serviceAccount = JSON.parse(raw);

    // Fix line break issue pada private key
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }

    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();

// Menentukan nama collection tujuan khusus slave (fallback ke 'bms_logs_slave')
const SLAVE_COLLECTION = (process.env.FIRESTORE_COLLECTION ? process.env.FIRESTORE_COLLECTION + "_slave" : null) || 'bms_logs_slave';

// Helper validasi token keamanan API
function checkAuthorization(request: NextRequest) {
    const authHeader = request.headers.get('authorization');
    const urlParams = request.nextUrl.searchParams;
    const querySecret = urlParams.get('secret');
    const bearerToken = authHeader ? authHeader.replace('Bearer ', '') : null;
    
    const validSecret = process.env.API_SECRET || process.env.CRON_SECRET;
    const isAuthorized = validSecret ? (bearerToken === validSecret || querySecret === validSecret) : true;

    return { isValid: validSecret ? isAuthorized : true };
}

// ==========================================
// POST: Murni menerima kiriman data dari Raspberry Pi & simpan ke bms_logs_slave
// ==========================================
export async function POST(request: NextRequest) {
    try {
        // 1. Validasi Keamanan Token
        const { isValid } = checkAuthorization(request);
        if (!isValid) {
            return NextResponse.json({ success: false, error: 'Unauthorized: Secret key salah atau tidak ada.' }, { status: 401 });
        }

        // 2. Ambil payload body JSON dari skrip Python
        const body = await request.json().catch(() => ({}));
        
        if (!body || Object.keys(body).length === 0) {
            return NextResponse.json(
                { success: false, error: "Payload body JSON kosong atau tidak valid!" },
                { status: 400 }
            );
        }

        // Helper akurat untuk format WIB: "2026-07-27T17:32:47+07:00"
        const getWibTimestampString = () => {
            const now = new Date();
            const formatter = new Intl.DateTimeFormat('sv-SE', {
                timeZone: 'Asia/Jakarta',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
            // sv-SE menghasilkan format "YYYY-MM-DD HH:mm:ss" secara rapi
            return formatter.format(now).replace(' ', 'T') + '+07:00';
        };

        // 3. Pastikan string timestamp tersedia (ambil dari body atau generate baru)
        const finalTimestamp = (body.timestamp && typeof body.timestamp === 'string') 
            ? body.timestamp 
            : getWibTimestampString();

        // 4. Susun data payload slave
        const slaveDocPayload = {
            timestamp: finalTimestamp,
            ah: body.ah !== undefined ? parseFloat(body.ah) : 0,
            soc: body.soc !== undefined ? parseFloat(body.soc) : 0,
            voltage: body.voltage !== undefined ? parseFloat(body.voltage) : 0,
            current: body.current !== undefined ? parseFloat(body.current) : 0,
            power: body.power !== undefined ? parseFloat(body.power) : 0,
            soh: body.soh !== undefined ? parseFloat(body.soh) : 100,
            cycleCount: body.cycleCount !== undefined ? parseInt(body.cycleCount, 10) : 0,
            temperature: body.temperature !== undefined ? parseFloat(body.temperature) : 0,
            statusBms: body.statusBms || 'STANDBY',
            cellVoltageAvg: body.cellVoltageAvg !== undefined ? parseFloat(body.cellVoltageAvg) : 0
        };

        // 5. Buat Custom Doc ID yang aman dari karakter ilegal (ganti colon ':' jadi dash '-')
        // Contoh hasil: "2026-07-28_23-56-08+07-00"
        const customDocId = finalTimestamp
            .replace(/[:.]/g, '-')
            .replace('T', '_');

        // 6. Simpan menggunakan .doc(customDocId).set() agar ID rapi dan terurut
        await db.collection(SLAVE_COLLECTION).doc(customDocId).set(slaveDocPayload);

        console.log(`✅ [SLAVE INSERT] Berhasil menyimpan data ke collection '${SLAVE_COLLECTION}' dengan ID: ${customDocId}`);

        return NextResponse.json({ 
            success: true, 
            docId: customDocId, 
            data: slaveDocPayload 
        });

    } catch (error: any) {
        console.error("❌ Gagal insert slave data:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}