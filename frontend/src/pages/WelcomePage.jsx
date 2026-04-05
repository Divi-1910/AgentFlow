import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import PixelSnow from '../components/ui/PixelSnow';

export default function WelcomePage() {
  const navigate = useNavigate();

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black font-body text-white">
      {/* Absolute Backdrop */}
      <div className="absolute inset-0 z-0">
        <PixelSnow
          color="#d4d4d4"
          flakeSize={0.02}
          minFlakeSize={1.5}
          pixelResolution={250}
          speed={0.8}
          depthFade={8}
          brightness={1.5}
          density={0.5}
          variant="snowflake"
        />
        {/* Gradients to add deep shadows to edges */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_transparent_0%,_#000000_120%)]" />
      </div>

      {/* Main Container */}
      <div className="relative z-10 grid w-full max-w-[85rem] grid-cols-1 gap-16 px-8 py-24 sm:px-12 lg:grid-cols-5 lg:gap-12 xl:px-8">

        {/* Left Typography Section */}
        <motion.div
          initial={{ opacity: 0, x: -40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col justify-center lg:col-span-3"
        >
          <h1 className="font-headline text-6xl font-extrabold leading-[1.02] tracking-tight sm:text-[5.5rem] lg:text-[6.5rem] xl:text-[7.5rem]">
            Agent<span className="font-light italic text-white/30">Flow</span>
          </h1>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6, duration: 1.2 }}
            className="mt-8 max-w-xl text-xl font-light leading-relaxed text-white/50 sm:text-2xl"
          >
            A definitive multi-agent platform. Connect models, orchestrate complex workflows, and automate the future with precision.
          </motion.p>
        </motion.div>

        {/* Right Glass Panel Section */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
          className="flex items-center justify-center lg:col-span-2 lg:justify-end"
        >
          <div className="group relative w-full overflow-hidden rounded-[2.5rem] border border-white/10 bg-white/[0.02] p-8 shadow-[0_32px_80px_-16px_rgba(0,0,0,1)] backdrop-blur-3xl sm:p-12">

            {/* Subtle internal shine effect */}
            <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-50 transition-opacity duration-700 group-hover:opacity-100" />

            <motion.h2
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7, duration: 0.8 }}
              className="font-headline text-4xl font-bold tracking-tight text-white mb-2"
            >
              Get Started
            </motion.h2>

            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8, duration: 0.8 }}
              className="mt-4 text-base font-light leading-relaxed text-white/50"
            >
              Signup or Login to manage your active orchestration clusters or create a new namespace.
            </motion.p>

            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.9, duration: 0.8 }}
              className="mt-12 flex flex-col sm:flex-row gap-4"
            >
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => navigate('/login')}
                className="group/btn relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-full bg-white px-6 py-4 shadow-[0_0_32px_rgba(255,255,255,0.15)] transition-all hover:bg-neutral-200 hover:shadow-[0_0_48px_rgba(255,255,255,0.3)]"
              >
                <span className="font-headline text-[13px] font-bold uppercase tracking-[0.1em] text-black">Login</span>
                <span className="material-symbols-outlined text-[16px] text-black transition-transform duration-300 group-hover/btn:translate-x-1">
                  arrow_forward
                </span>
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => navigate('/signup')}
                className="flex w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-6 py-4 font-headline text-[13px] font-bold uppercase tracking-[0.1em] text-white transition-colors hover:bg-white/[0.08]"
              >
                Sign up
              </motion.button>
            </motion.div>
          </div>
        </motion.div>

      </div>
    </div>
  );
}
