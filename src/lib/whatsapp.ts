import axios, { AxiosResponse } from 'axios';

interface WhatsAppConfig {
    rawUrl: string;
    scode: string;
    number: string;
    token: string;
}

interface ApiResponseData {
    status?: string;
    message?: string;
    session?: string;
    [key: string]: any;
}

class WhatsAppService {
    private config: WhatsAppConfig;

    constructor() {
        const rawToken = process.env.WA_TOKEN || '';
        
        // --- DEBUG TOKEN DI SINI ---
        console.log(`🔍 [WA DEBUG] Panjang Token: ${rawToken.length}`);
        console.log(`🔍 [WA DEBUG] 5 Karakter Awal Token: ${rawToken.substring(0, 5)}...`);
        console.log(`🔍 [WA DEBUG] 5 Karakter Akhir Token: ...${rawToken.substring(rawToken.length - 5)}`);

        this.config = {
            rawUrl: process.env.WA_API_URL || '',
            scode: '', 
            number: process.env.WA_TARGET_NUMBER || '',
            token: rawToken,
        };
    }

    /**
     * Helper buat ngerender URL asli berdasarkan template dari Gateway Configuration
     */
    private renderUrl(endpoint: string): string {
        const formattedBase = this.config.rawUrl
            .replaceAll('{scode}', this.config.scode)
            .replaceAll('{number}', this.config.number)
            .replace(/\/$/, ''); // Buang slash di paling ujung jika ada

        return `${formattedBase}/${endpoint}`;
    }

    private async callApi(endpoint: string, data: Record<string, any> = {}): Promise<AxiosResponse<ApiResponseData>> {
        const finalUrl = this.renderUrl(endpoint);

        console.log(`🚀 [WA API CALL] Target URL: ${finalUrl}`);
        console.log(`🔑 [WA API CALL] Bearer Token terpasang: Bearer ${this.config.token}`);

        return axios.post<ApiResponseData>(finalUrl, data, {
            headers: { 
                Authorization: `Bearer ${this.config.token}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000 // Timeout 30 detik
        });
    }

    /**
     * 🚀 HELPER: Bersihkan nomor telepon dari spasi/karakter aneh & standarisasi ke format (62)
     */
    public cleanPhoneNumber(whatsappNumber?: string): string {
        if (!whatsappNumber) return '';
        
        // Catatan: Jika nomor berupa Group ID (berakhiran @g.us), jangan bersihkan format huruf/simbolnya secara agresif
        if (whatsappNumber.endsWith('@g.us')) {
            return whatsappNumber.trim();
        }
        
        let cleanNumber = whatsappNumber.replace(/[^0-9]/g, '').trim();
        
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '62' + cleanNumber.slice(1);
        }
        
        return cleanNumber;
    }

    /**
     * 🚀 SEND MESSAGE (Instan - Plus Manual Typing Simulation)
     */
    public async sendMessage(whatsappNumber?: string, message?: string): Promise<any> {
        const phone = this.cleanPhoneNumber(whatsappNumber);
        
        if (!phone) {
            console.warn('⚠️ Gagal kirim WA instan: Nomor telepon kosong atau tidak valid.');
            return { success: false, message: 'Skipped due to empty phone number' };
        }

        try {
            await this.callApi('typing', { phone, value: true }).catch(() => {});

            const charCount = message?.length || 0;
            let delayMs = Math.max(1500, Math.min((charCount / 15) * 1000, 8000));
            await new Promise((resolve) => setTimeout(resolve, delayMs));

            const result = await this.callApi('send-message', { phone, message });
            const resData = result.data;

            if (resData && resData.status === 'Disconnected') {
                throw new Error(`WhatsApp Gateway Disconnected: ${resData.message || 'Sesi tidak aktif.'}`);
            }

            if (resData && resData.status === 'Connected' && resData.message?.includes('não existe')) {
                const sessionDevice = resData.session || '';
                if (sessionDevice && resData.message.includes(sessionDevice)) {
                    throw new Error(`WhatsApp Gateway Device Logout: Sesi aktif tapi nomor perangkat utama terdepak.`);
                } else {
                    throw new Error(`Target Number Invalid: Nomor tujuan +${phone} tidak terdaftar di WhatsApp.`);
                }
            }

            await this.callApi('typing', { phone, value: false }).catch(() => {});
            return resData;
        } catch (error: any) {
            await this.callApi('typing', { phone, value: false }).catch(() => {});
            throw error;
        }
    }

    /**
     * 📦 QUEUE MESSAGE (Massal / Antrean Engine)
     */
    public async queueMessage(whatsappNumber?: string, message?: string): Promise<any> {
        const phone = this.cleanPhoneNumber(whatsappNumber);
        
        if (!phone) {
            console.warn('⚠️ Gagal antrekan WA: Nomor telepon kosong atau tidak valid.');
            return { success: false, message: 'Skipped due to empty phone number' };
        }

        try {
            const result = await this.callApi('queue-message', { phone, message });
            return result.data;
        } catch (error: any) {
            throw error;
        }
    }
}

// Export instance langsung biar gampang dipanggil di file route.ts
export default new WhatsAppService();