import coffeenaduLogoImg from '../assets/images/coffeenadu_logo.jpg';

interface CoffeeCupLogoProps {
  className?: string;
}

export function CoffeeCupLogo({ className = 'w-9 h-9' }: CoffeeCupLogoProps) {
  return (
    <img
      src={coffeenaduLogoImg}
      alt="Coffeenadu News logo"
      className={`${className} rounded-full object-cover shadow-2xs ring-1 ring-amber-400/50`}
    />
  );
}
