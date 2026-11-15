import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, ImageUp, Keyboard, QrCode, X } from 'lucide-react';

interface QrScannerModalProps {
  open: boolean;
  onClose: () => void;
  onPairValue: (codeOrUrl: string) => Promise<void>;
}

type ScanTab = 'camera' | 'code' | 'image';

export function QrScannerModal({ open, onClose, onPairValue }: QrScannerModalProps) {
  const [tab, setTab] = useState<ScanTab>('camera');
  const [manualCode, setManualCode] = useState('');
  const [statusMessage, setStatusMessage] = useState<string>('Point your camera at the DeskBridge QR code on your Windows computer.');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPairing, setIsPairing] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open || tab !== 'camera') {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      return;
    }

    let cancelled = false;

    async function startCamera() {
      setErrorMessage(null);
      setStatusMessage('Requesting camera access for QR scan...');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatusMessage('Scanning for DeskBridge QR code...');

        const scanFrame = () => {
          if (cancelled) return;
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const detected = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert',
              });
              if (detected && detected.data) {
                setStatusMessage('QR code detected. Connecting...');
                setIsPairing(true);
                onPairValue(detected.data)
                  .then(() => {
                    onClose();
                  })
                  .catch((err: Error) => {
                    setErrorMessage(err.message);
                    setIsPairing(false);
                  });
                return;
              }
            }
          }
          rafRef.current = requestAnimationFrame(scanFrame);
        };

        rafRef.current = requestAnimationFrame(scanFrame);
      } catch {
        setErrorMessage('Camera access unavailable in this browser context. Use Quick Code or Upload QR Image instead.');
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [open, tab, onPairValue, onClose]);

  if (!open) return null;

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    setErrorMessage(null);
    setIsPairing(true);
    try {
      await onPairValue(manualCode.trim());
      setManualCode('');
      onClose();
    } catch (err) {
      setErrorMessage((err as Error).message);
    } finally {
      setIsPairing(false);
    }
  };

  const handleImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMessage(null);
    setIsPairing(true);
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not decode image.');
      ctx.drawImage(bitmap, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const decoded = jsQR(imgData.data, imgData.width, imgData.height);
      if (!decoded?.data) {
        throw new Error('No DeskBridge QR code was found in that image.');
      }
      await onPairValue(decoded.data);
      onClose();
    } catch (err) {
      setErrorMessage((err as Error).message);
    } finally {
      setIsPairing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
    >
      <div className="w-full sm:max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-3xl sm:rounded-2xl overflow-hidden shadow-2xl">
        <div className="w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mt-3 sm:hidden" />

        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <QrCode className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h2 id="qr-modal-title" className="text-base font-semibold text-slate-900 dark:text-white">
              Pair Windows Computer
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label="Close pairing dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl">
            <button
              type="button"
              onClick={() => setTab('camera')}
              className={`min-h-[44px] flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                tab === 'camera'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Camera className="w-4 h-4" />
              <span>Scan QR</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('code')}
              className={`min-h-[44px] flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                tab === 'code'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Keyboard className="w-4 h-4" />
              <span>Enter Code</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('image')}
              className={`min-h-[44px] flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                tab === 'image'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <ImageUp className="w-4 h-4" />
              <span>QR Image</span>
            </button>
          </div>

          {tab === 'camera' && (
            <div className="space-y-3">
              <div className="relative aspect-[4/3] w-full rounded-xl overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center">
                <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
                <canvas ref={canvasRef} className="hidden" />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="w-48 h-48 border-2 border-blue-500/80 rounded-2xl shadow-[0_0_0_9999px_rgba(9,13,22,0.45)]" />
                </div>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 text-center">{statusMessage}</p>
            </div>
          )}

          {tab === 'code' && (
            <form onSubmit={handleManualSubmit} className="space-y-3">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                6-Character Pairing Code or Pair Link
              </label>
              <input
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="e.g. A7K92M or https://..."
                className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-sm font-mono tracking-wider text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                autoFocus
              />
              <button
                type="submit"
                disabled={isPairing || !manualCode.trim()}
                className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
              >
                {isPairing ? 'Connecting...' : 'Connect to Computer'}
              </button>
            </form>
          )}

          {tab === 'image' && (
            <div className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageFile}
                className="hidden"
                id="qr-image-upload"
              />
              <label
                htmlFor="qr-image-upload"
                className="flex flex-col items-center justify-center gap-2 min-h-[160px] rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 cursor-pointer hover:border-blue-500 transition-colors p-6 text-center"
              >
                <ImageUp className="w-7 h-7 text-blue-600 dark:text-blue-400" />
                <span className="text-sm font-medium text-slate-900 dark:text-white">
                  {isPairing ? 'Decoding QR code...' : 'Choose QR Screenshot or Photo'}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Decodes the DeskBridge pairing QR directly on your device
                </span>
              </label>
            </div>
          )}

          {errorMessage && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-600 dark:text-red-400">
              {errorMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
