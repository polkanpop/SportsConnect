/** @type {import('tailwindcss').Config} */
module.exports = {
  // NOTE: Update this to include the paths to all of your component files.
  content: ["./app/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors:{
        primary: '#030014',
        secondary: '#ffc700',
        light: {
          100: '#F59FF5',
          200: '#48EF8D',
          300: '#9CA4AB',
          400: '#ffffff',
          500: '#FFA500',
          
        },
        dark:{
          100: '#221F3D',
          200: '#0f0d23',
          300: '#6A6B6B'
        }
      }
    },
  },
  plugins: [],
}