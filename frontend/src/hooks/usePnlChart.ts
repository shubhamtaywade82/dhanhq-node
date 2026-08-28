import { useRef, useEffect, useCallback } from 'react';
import { fmt } from '../utils/formatters';

export function usePnlChart(data: number[]) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.offsetParent === null) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    canvas.width = rect.width - 32;
    canvas.height = 190;
    const w = canvas.width;
    const h = canvas.height;
    const pad = { top: 15, right: 60, bottom: 25, left: 10 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    const min = Math.min(...data, 0);
    const max = Math.max(...data);
    const range = max - min || 1;

    ctx.strokeStyle = 'rgba(28, 40, 63, 0.7)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    const zeroY = pad.top + ch * (1 - (0 - min) / range);
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.3)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(w - pad.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    const isPos = data[data.length - 1] >= 0;
    const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
    if (isPos) {
      grad.addColorStop(0, 'rgba(0, 229, 160, 0.16)');
      grad.addColorStop(1, 'rgba(0, 229, 160, 0.0)');
    } else {
      grad.addColorStop(0, 'rgba(255, 59, 92, 0.0)');
      grad.addColorStop(1, 'rgba(255, 59, 92, 0.16)');
    }

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad.left + (i / (data.length - 1)) * cw;
      const y = pad.top + ch * (1 - (v - min) / range);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.left + cw, h - pad.bottom);
    ctx.lineTo(pad.left, h - pad.bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad.left + (i / (data.length - 1)) * cw;
      const y = pad.top + ch * (1 - (v - min) / range);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = isPos ? '#00e5a0' : '#ff3b5c';
    ctx.lineWidth = 2;
    ctx.stroke();

    const lastX = pad.left + cw;
    const lastY = pad.top + ch * (1 - (data[data.length - 1] - min) / range);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = isPos ? '#00e5a0' : '#ff3b5c';
    ctx.fill();

    ctx.font = '10px JetBrains Mono';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = max - (range / 4) * i;
      ctx.fillText(fmt(v, 0), w - 6, pad.top + (ch / 4) * i + 3);
    }
    ctx.textAlign = 'center';
    ['09:15', '10:00', '10:45', '11:30'].forEach((l, i) => {
      ctx.fillText(l, pad.left + (i / 3) * cw, h - 6);
    });
  }, [data]);

  useEffect(() => {
    draw();
    const handleResize = () => draw();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw]);

  return canvasRef;
}
