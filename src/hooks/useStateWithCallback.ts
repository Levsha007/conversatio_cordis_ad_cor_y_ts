import { useState, useCallback, useRef, useEffect } from 'react';

type Callback<T> = (state: T) => void;
type SetStateCallback<T> = (newState: T | ((prevState: T) => T), cb?: Callback<T>) => void;

const useStateWithCallback = <T>(initialState: T): [T, SetStateCallback<T>] => {
    const [state, setState] = useState<T>(initialState);
    const cbRef = useRef<Callback<T> | null>(null);

    const updateState: SetStateCallback<T> = useCallback((newState, cb) => {
        cbRef.current = cb || null;
        setState(prev => 
            typeof newState === 'function' 
                ? (newState as (prev: T) => T)(prev)
                : newState
        );
    }, []);

    useEffect(() => {
        if (cbRef.current) {
            cbRef.current(state);
            cbRef.current = null;
        }
    }, [state]);

    return [state, updateState];
};

export default useStateWithCallback;