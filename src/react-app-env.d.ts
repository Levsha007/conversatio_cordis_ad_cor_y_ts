// src/react-app-env.d.ts
/// <reference types="react-scripts" />

// Объявление для CSS Modules
declare module '*.module.css' {
    const classes: { readonly [key: string]: string };
    export default classes;
  }