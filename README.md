# Decibel Meter Pro

A premium Windows desktop application for real-time decibel monitoring, noise tracking, and alerting. Built with **Electron**, **React**, and **Vite**.

## Features

-   **High-Precision Monitoring**: Real-time dB measurement with smoothed display for better readability.
-   **Session History**: Track noise peaks over time with a toggleable view (Live 5s vs. Session 4h).
-   **Smart Duration Filter**: Avoid false positives from short noises (like coughs) by requiring sustained noise levels.
-   **Native Notifications**: Windows system notifications when thresholds are exceeded.
-   **Log Export**: Save noise events to a CSV file for long-term analysis.
-   **System Tray Integration**: Runs quietly in the background.
-   **Premium UI**: Modern glassmorphism design with fluid animations.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- npm (standard with Node.js)

### Installation

1. Clone or download the repository.
2. Install dependencies:
   ```bash
   npm install
   ```

### Development

Run the application in development mode:
```bash
npm run electron:dev
```

### Building for Production

To create a standalone `.exe` (Windows):
```bash
npm run electron:build
```
The output will be found in the `release/win-unpacked` folder.

## Built With

- **Framework**: Electron
- **Frontend**: React + Vite
- **Styling**: Vanilla CSS (Glassmorphism)
- **Icons**: Lucide React
- **Animations**: Framer Motion

---
*Concept & Design by Albert Boersen*

If you find this tool useful, consider supporting me with a coffee:
[☕ Buy me a coffee](https://buymeacoffee.com/albertboursin)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
