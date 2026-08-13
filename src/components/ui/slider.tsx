import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: SliderPrimitive.Root.Props) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-muted select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1"
        >
          {/**
           * The filled part of the track is a readout, not an action.
           *
           * It shipped as `bg-primary`, which put the interactive accent on a value.
           * A panel of sliders then read as a panel of solid accent and the colour
           * stopped meaning "you can act on this". The thumb is the control and keeps
           * the accent; the track only shows where the value sits.
           */}
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-foreground/30 select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            /* the thumb is the control, so it is the part that carries the accent, and
               it grows on press so a drag is acknowledged under the finger */
            className="relative block size-3.5 shrink-0 cursor-grab rounded-full border-2 border-primary bg-background ring-ring/50 transition-[box-shadow,transform] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:scale-110 active:cursor-grabbing active:ring-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
