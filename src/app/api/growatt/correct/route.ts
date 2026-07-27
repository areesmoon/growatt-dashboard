import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Inisialisasi Firebase Admin aman dari multiple instances di Next.js
if (getApps().length === 0) {
    
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY not found");

    const serviceAccount = JSON.parse(raw);

    // Fix line break issue
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }

    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || 'bms_logs';
const SLAVE_CAPACITY_AH = parseFloat(process.env.SLAVE_CAPACITY_AH || '100');

export async function GET(request: NextRequest) {
    try {
        // 1. Keamanan Token Header / Query Secret dari browser / cron-job
        const authHeader = request.headers.get('authorization');
        const urlParams = request.nextUrl.searchParams;
        const querySecret = urlParams.get('secret');
        
        const bearerToken = authHeader ? authHeader.replace('Bearer ', '') : null;
        const isAuthorized = (process.env.CRON_SECRET && (bearerToken === process.env.CRON_SECRET || querySecret === process.env.CRON_SECRET));

        if (process.env.CRON_SECRET && !isAuthorized) {
            return NextResponse.json({ error: 'Unauthorized: Secret key salah atau tidak ada.' }, { status: 401 });
        }

        // 2. Ambil parameter target_ah dari URL Query (Contoh: /api/growatt/correct?target_ah=100&secret=xxx)
        const targetAhParam = urlParams.get('target_ah');
        const targetSlaveAh = targetAhParam ? parseFloat(targetAhParam) : NaN;

        if (isNaN(targetSlaveAh)) {
            return NextResponse.json(
                { success: false, error: "Parameter target_ah wajib diisi dengan format angka yang valid! (Contoh: ?target_ah=100&secret=KODE_RAHASIA)" },
                { status: 400 }
            );
        }

        const collectionRef = db.collection(FIRESTORE_COLLECTION);

        // 3. Ambil data TERAKHIR (limit 1 descending)
        const lastSnapshot = await collectionRef.orderBy('timestamp', 'desc').limit(1).get();
        if (lastSnapshot.empty) {
            return NextResponse.json(
                { success: false, error: `Tidak ada data ditemukan di collection: ${FIRESTORE_COLLECTION}` },
                { status: 404 }
            );
        }

        const lastDoc = lastSnapshot.docs[0];
        const lastData = lastDoc.data();
        const lastId = lastDoc.id;

        console.log(`📄 Dokumen Terakhir [ID: ${lastId}] : ${lastData.timestamp}`);
        console.log(`   └─ Master SOC: ${lastData.master?.soc}% | Current Slave Ah: ${lastData.slave?.ah}Ah`);

        // 4. Ambil parameter calibration saat ini
        const calib = lastData.calibration || {};
        const oldChargeFactor = parseFloat(calib.chargeCorrectionFactor || '1.0');
        const oldDischargeFactor = parseFloat(calib.dischargeCorrectionFactor || '1.0');
        const totalCount = parseInt(calib.totalCount || '1', 10);

        console.log(`📊 Statistik Kalibrasi Aktif: Total Data Count = ${totalCount}`);
        console.log(`   - Old Charge Factor    : ${oldChargeFactor}`);
        console.log(`   - Old Discharge Factor : ${oldDischargeFactor}`);

        // 5. Batasi target slave Ah sesuai kapasitas nominal
        const clampedTargetSlaveAh = Math.min(SLAVE_CAPACITY_AH, Math.max(0, targetSlaveAh));
        const currentSlaveAh = parseFloat(lastData.slave?.ah || '0');
        const ahDiff = clampedTargetSlaveAh - currentSlaveAh;

        console.log(`⚖️ Target Slave Ah: ${clampedTargetSlaveAh}Ah | Aktual di DB: ${currentSlaveAh}Ah | Selisih (Error): ${ahDiff.toFixed(2)}Ah`);

        // 6. Hitung indikasi koreksi rasio baru
        let adjustmentRatio = 1.0;
        if (currentSlaveAh > 0) {
            adjustmentRatio = clampedTargetSlaveAh / currentSlaveAh;
        }

        let calculatedChargeFactor = oldChargeFactor * adjustmentRatio;
        let calculatedDischargeFactor = oldDischargeFactor * adjustmentRatio;

        // 7. PENERAPAN PERGESERAN LANDAI (SMOOTH SHIFT / DAMPING)
        const learningRate = 0.15; 

        const newChargeFactor = (oldChargeFactor * (1 - learningRate)) + (calculatedChargeFactor * learningRate);
        const newDischargeFactor = (oldDischargeFactor * (1 - learningRate)) + (calculatedDischargeFactor * learningRate);

        const newSoc = parseFloat(((clampedTargetSlaveAh / SLAVE_CAPACITY_AH) * 100).toFixed(2));

        console.log(`\n--- HASIL KALIBRASI ADAPTIF ---`);
        console.log(`   👉 NEW Charge Factor    : ${newChargeFactor.toFixed(4)} (Geser dari ${oldChargeFactor})`);
        console.log(`   👉 NEW Discharge Factor : ${newDischargeFactor.toFixed(4)} (Geser dari ${oldDischargeFactor})`);
        console.log(`   👉 New Slave Ah & SOC   : ${clampedTargetSlaveAh}Ah (${newSoc}%)`);

        // 8. Update dokumen terakhir di Firestore
        let updates = {
            "slave.ah": clampedTargetSlaveAh,
            "slave.soc": newSoc,
            "calibration.chargeCorrectionFactor": parseFloat(newChargeFactor.toFixed(4)),
            "calibration.dischargeCorrectionFactor": parseFloat(newDischargeFactor.toFixed(4)),
            "calibration.totalCount": 1 // Reset counter untuk memulai siklus pembelajaran baru
        };

        await collectionRef.doc(lastId).update(updates);

        console.log(`\n✅ Berhasil update database [ID: ${lastId}]!`);

        return NextResponse.json({
            success: true,
            message: "Berhasil melakukan kalibrasi adaptif via GET",
            updatedDocId: lastId,
            targetSlaveAh: clampedTargetSlaveAh,
            newSoc,
            newChargeFactor: parseFloat(newChargeFactor.toFixed(4)),
            newDischargeFactor: parseFloat(newDischargeFactor.toFixed(4))
        });

    } catch (error: any) {
        console.error("❌ Gagal menjalankan koreksi adaptif:", error.message);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}