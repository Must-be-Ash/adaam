import type { ReactNode } from "react";
import { BatteryMedium, Signal, Wifi } from "lucide-react";

interface IphoneFrameProps {
  children: ReactNode;
}

export default function IphoneFrame({ children }: IphoneFrameProps) {
  return (
    <div
      className="relative mx-auto w-[300px] rounded-[52px] bg-linear-to-b from-[#dedee2] via-[#8e8e93] to-[#444448] p-[9px] shadow-[0_32px_80px_rgba(0,0,0,0.34)] sm:w-[340px]"
      aria-label="iPhone showing an Eve conversation"
    >
      <div className="relative h-[650px] overflow-hidden rounded-[43px] bg-[#1c1c1e] ring-1 ring-black/80">
        <div
          className="absolute top-0 left-1/2 z-30 h-[34px] w-[132px] -translate-x-1/2 rounded-b-[20px] bg-black"
          aria-hidden="true"
        >
          <span className="absolute top-[12px] left-[43px] h-[7px] w-[47px] rounded-full bg-[#242426]" />
          <span className="absolute top-[11px] right-[19px] size-[9px] rounded-full bg-[#101012] ring-1 ring-[#35353a]" />
        </div>

        <div className="absolute inset-x-0 top-0 z-20 flex h-[49px] items-center justify-between px-5 pt-1 text-white">
          <span className="text-[12px] font-semibold tracking-[-0.02em]">
            18:35
          </span>
          <span className="flex items-center gap-1.5" aria-hidden="true">
            <Signal size={13} strokeWidth={2.4} />
            <Wifi size={14} strokeWidth={2.2} />
            <BatteryMedium size={17} strokeWidth={2.1} />
          </span>
        </div>

        <div className="pt-[49px]">
          <div className="h-[372px] sm:h-[442px] lg:h-[502px]">{children}</div>
        </div>
      </div>
    </div>
  );
}
