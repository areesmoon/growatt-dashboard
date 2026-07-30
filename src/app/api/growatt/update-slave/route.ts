import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Inisialisasi Firebase Admin aman dari multiple instances di Next.js
if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not found");

    const serviceAccount = JSON.parse(raw);

    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }

    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'bms_logs';

export async function POST(request: NextRequest) {
    try {
        // 1. Keamanan Token Header / Secret Key
        const authHeader = request.headers.get('authorization');
        const bearerToken = authHeader ? authHeader.replace('Bearer ', '') : null;
        
        const validSecret = process.env.API_SECRET || process.env.CRON_SECRET;
        const isAuthorized = validSecret ? (bearerToken === validSecret) : true;

        if (validSecret && !isAuthorized) {
            return NextResponse.json({ success: false, error: 'Unauthorized: API Secret salah atau tidak ada.' }, { status: 401 });
        }

        // 2. Ambil payload body JSON yang dikirim dari skrip Python
        const body = await request.json().catch(() => ({}));
        
        if (!body || Object.keys(body).length === 0) {
            return NextResponse.json(
                { success: false, error: "Payload body JSON kosong atau tidak valid!" },
                { status: 400 }
            );
        }

        const collectionRef = db.collection(FIRESTORE_COLLECTION);

        // 3. Ambil data TERAKHIR (limit 1 descending) untuk di-update bagian field 'slave'-nya
        const lastSnapshot = await collectionRef.orderBy('timestamp', 'desc').limit(1).get();
        if (lastSnapshot.empty) {
            return NextResponse.json(
                { success: false, error: `Tidak ada data ditemukan di collection: ${FIRESTORE_COLLECTION}` },
                { status: 404 }
            );
        }

        const lastDoc = lastSnapshot.docs[0];
        const lastId = lastDoc.id;

        console.log(`📄 Update Field Slave untuk Dokumen Terakhir [ID: ${lastId}]`);

        // 4. Susun payload field 'slave' langsung dari data yang diposting Python
        const slavePayload = {
            ah: body.ah !== undefined ? parseFloat(body.ah) : 0,
            soc: body.soc !== undefined ? parseFloat(body.soc) : 0,
            voltage: body.voltage !== undefined ? parseFloat(body.voltage) : 0,
            current: body.current !== undefined ? parseFloat(body.current) : 0,
            power: body.power !== undefined ? parseFloat(body.power) : 0,
            soh: body.soh !== undefined ? parseFloat(body.soh) : 0,
            cycleCount: body.cycleCount !== undefined ? parseInt(body.cycleCount, 10) : 0,
            temperature: body.temperature !== undefined ? parseFloat(body.temperature) : 0,
            statusBms: body.statusBms || 'STANDBY',
            cellVoltageAvg: body.cellVoltageAvg !== undefined ? parseFloat(body.cellVoltageAvg) : 0
        };

        // 5. Eksekusi update spesifik ke field 'slave' pada dokumen terakhir Firestore
        await collectionRef.doc(lastId).update({
            slave: slavePayload
        });

        console.log(`✅ Berhasil update field 'slave' [ID: ${lastId}] | Status: ${slavePayload.statusBms} | Current: ${slavePayload.current}A`);

        return NextResponse.json({ 
            success: true, 
            updatedDocId: lastId, 
            slave: slavePayload 
        });

    } catch (error: any) {
        console.error("❌ Gagal update slave via POST:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}