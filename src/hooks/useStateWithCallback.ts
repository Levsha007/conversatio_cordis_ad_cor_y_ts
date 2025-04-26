import { useState, useCallback, useRef, useEffect } from 'react';

// Тип callback-функции, которая будет вызвана после обновления состояния
type Callback<T> = (state: T) => void;

// Тип функции для обновления состояния с возможностью передачи callback
type SetStateCallback<T> = (
  newState: T | ((prevState: T) => T), // Новое состояние или функция для его вычисления
  cb?: Callback<T> // Опциональный callback
) => void;

/**
 * Кастомный хук useState с callback после обновления состояния
 * @template T - тип состояния
 * @param initialState - начальное состояние
 * @returns [текущее состояние, функция обновления с callback]
 */
const useStateWithCallback = <T>(initialState: T): [T, SetStateCallback<T>] => {
    // Стандартный useState для хранения состояния
    const [state, setState] = useState<T>(initialState);
    
    // Ref для хранения callback-функции между рендерами
    const cbRef = useRef<Callback<T> | null>(null);

    /**
     * Функция обновления состояния с поддержкой callback
     * @param newState - новое состояние или функция для его вычисления
     * @param cb - callback, который будет вызван после обновления состояния
     */
    const updateState: SetStateCallback<T> = useCallback((newState, cb) => {
        // Сохраняем callback в ref
        cbRef.current = cb || null;
        
        // Обновляем состояние, обрабатывая как значение, так и функцию
        setState(prev => 
            typeof newState === 'function' 
                ? (newState as (prev: T) => T)(prev) // Если передана функция - вызываем её
                : newState // Иначе используем значение напрямую
        );
    }, []);

    // Эффект для вызова callback после обновления состояния
    useEffect(() => {
        if (cbRef.current) {
            cbRef.current(state); // Вызываем callback с новым состоянием
            cbRef.current = null; // Очищаем ref
        }
    }, [state]); // Зависимость от state - эффект срабатывает при его изменении

    return [state, updateState];
};

export default useStateWithCallback;